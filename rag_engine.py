import os
import re
import json
import numpy as np
import faiss
from groq import Groq
from dotenv import load_dotenv

load_dotenv()

class RAGEngine:
    def __init__(self):
        self.groq_client = None
        self.model = os.getenv('GROQ_MODEL', 'llama-3.1-8b-instant')
        self.is_initialized = False
        self.resume_data = {}
        self.chunks = []
        self.embeddings = None
        self.index = None
        self.embedding_dim = 384
        
        api_key = os.getenv('GROQ_API_KEY')
        if api_key:
            self.groq_client = Groq(api_key=api_key)
    
    def _get_embedding(self, text):
        text = text.lower().strip()
        words = text.split()
        
        embedding = np.zeros(self.embedding_dim)
        for i, word in enumerate(words[:self.embedding_dim]):
            hash_val = hash(word) % 10000
            embedding[i % self.embedding_dim] += hash_val / 10000.0
        
        norm = np.linalg.norm(embedding)
        if norm > 0:
            embedding = embedding / norm
        
        return embedding.astype('float32')
    
    def _chunk_text(self, text, chunk_size=500, overlap=100):
        words = text.split()
        chunks = []
        
        for i in range(0, len(words), chunk_size - overlap):
            chunk = ' '.join(words[i:i + chunk_size])
            if chunk.strip():
                chunks.append(chunk)
        
        return chunks
    
    def index_resume(self, parsed_data):
        self.resume_data = parsed_data
        self.chunks = []
        
        for section, content in parsed_data.items():
            if isinstance(content, str) and content.strip():
                section_chunks = self._chunk_text(content)
                for chunk in section_chunks:
                    self.chunks.append({
                        'section': section,
                        'content': chunk
                    })
        
        if not self.chunks:
            raise Exception("No content found in resume")
        
        embeddings_list = []
        for chunk in self.chunks:
            emb = self._get_embedding(chunk['content'])
            embeddings_list.append(emb)
        
        self.embeddings = np.array(embeddings_list).astype('float32')
        index = faiss.IndexFlatL2(self.embedding_dim)
        index.add(self.embeddings)
        self.index = index
        
        self.is_initialized = True
    
    def _retrieve_context(self, query: str, top_k: int = 3) -> list:
        if not self.is_initialized or self.index is None:
            return []
        
        query_embedding = self._get_embedding(query).reshape(1, -1)
        distances, indices = self.index.search(query_embedding, min(top_k, len(self.chunks)))
        
        results = []
        for idx in indices[0]:
            if idx < len(self.chunks):
                results.append(self.chunks[idx])
        
        return results
    
    def _call_llm(self, prompt, max_tokens=500):
        if not self.groq_client:
            raise Exception("Groq API key not configured")
        
        try:
            response = self.groq_client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": "You are an intelligent assistant helping to fill job application forms. Be concise and accurate. Only provide the exact value needed for the form field."},
                    {"role": "user", "content": prompt}
                ],
                max_tokens=max_tokens,
                temperature=0.3
            )
            content = response.choices[0].message.content
            return content.strip() if content else ""
        except Exception as e:
            raise Exception(f"LLM API error: {str(e)}")
    
    def get_autofill_value(self, field_label, field_type='text', context='', existing_value=''):
        query = f"{field_label} {context}"
        relevant_chunks = self._retrieve_context(query, top_k=5)
        
        if not relevant_chunks:
            return {
                "value": "",
                "confidence": 0,
                "needs_manual": True,
                "suggestion": f"Could not find relevant information for '{field_label}'"
            }
        
        context_text = "\n".join([f"[{c['section']}]: {c['content']}" for c in relevant_chunks])
        
        extracted_info = self.resume_data.get('extracted_info', {})
        field_lower = field_label.lower()
        
        if 'email' in field_lower and 'email' in extracted_info:
            return {"value": extracted_info['email'], "confidence": 1.0, "needs_manual": False, "source": "direct_extraction"}
        if 'phone' in field_lower and 'phone' in extracted_info:
            return {"value": extracted_info['phone'], "confidence": 1.0, "needs_manual": False, "source": "direct_extraction"}
        if ('name' in field_lower and 'first' not in field_lower and 'last' not in field_lower) and 'name' in extracted_info:
            return {"value": extracted_info['name'], "confidence": 0.9, "needs_manual": False, "source": "direct_extraction"}
        if 'linkedin' in field_lower and 'linkedin' in extracted_info:
            return {"value": extracted_info['linkedin'], "confidence": 1.0, "needs_manual": False, "source": "direct_extraction"}
        if 'github' in field_lower and 'github' in extracted_info:
            return {"value": extracted_info['github'], "confidence": 1.0, "needs_manual": False, "source": "direct_extraction"}
        
        prompt = f"""Based on the following resume information, provide the value for the form field.

Resume Context:
{context_text}

Form Field: {field_label}
Field Type: {field_type}
Additional Context: {context}
Current Value (if any): {existing_value}

Instructions:
1. If you find the exact information, provide it directly.
2. If you're unsure or the information is not available, respond with: NEEDS_MANUAL
3. Keep the response concise - only the value needed for the field.
4. For name fields, provide the full name or appropriate part (first/last).
5. For date fields, use the format that makes sense (MM/YYYY or similar).

Response (just the value or NEEDS_MANUAL):"""
        
        try:
            response = self._call_llm(prompt, max_tokens=200)
            
            if 'NEEDS_MANUAL' in response.upper() or len(response) > 500:
                return {
                    "value": "",
                    "confidence": 0,
                    "needs_manual": True,
                    "suggestion": f"Please fill '{field_label}' manually - AI is unsure"
                }
            
            return {
                "value": response,
                "confidence": 0.8,
                "needs_manual": False,
                "source": "llm_generated"
            }
        except Exception as e:
            return {
                "value": "",
                "confidence": 0,
                "needs_manual": True,
                "suggestion": f"Error: {str(e)}"
            }
    
    def answer_hr_question(self, question, job_context=''):
        relevant_chunks = self._retrieve_context(question, top_k=5)
        
        context_text = "\n".join([f"[{c['section']}]: {c['content']}" for c in relevant_chunks])
        
        prompt = f"""You are helping a job applicant answer an HR question based on their resume.

Resume Context:
{context_text}

Job Context: {job_context if job_context else 'General job application'}

HR Question: {question}

Instructions:
1. Provide a professional, personalized answer based on the resume information.
2. Highlight relevant skills, experience, and achievements.
3. Be concise but comprehensive (2-4 sentences).
4. If you cannot answer based on the resume, indicate that the user should provide more details.

Answer:"""
        
        try:
            response = self._call_llm(prompt, max_tokens=500)
            return {
                "answer": response,
                "confidence": 0.85,
                "needs_manual": False
            }
        except Exception as e:
            return {
                "answer": "",
                "confidence": 0,
                "needs_manual": True,
                "error": str(e)
            }
    
    def get_structured_data(self):
        return {
            "sections": list(self.resume_data.keys()),
            "extracted_info": self.resume_data.get('extracted_info', {}),
            "chunk_count": len(self.chunks)
        }
    
    def get_multi_entries(self, section):
        section_content = self.resume_data.get(section, '')
        if not section_content:
            return []
        
        prompt = f"""Parse the following {section} section and extract individual entries as a JSON array.

Content:
{section_content}

Instructions:
1. Extract each {section} entry separately.
2. For education: include institution, degree, field, dates
3. For experience: include company, title, dates, description
4. For projects: include name, description, technologies
5. Return as a JSON array of objects.

JSON Array:"""
        
        try:
            response = self._call_llm(prompt, max_tokens=1000)
            
            json_match = re.search(r'\[.*\]', response, re.DOTALL)
            if json_match:
                entries = json.loads(json_match.group())
                return entries
            return []
        except:
            return []
