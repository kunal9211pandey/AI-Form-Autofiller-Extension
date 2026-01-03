import os
import uuid
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv
from werkzeug.utils import secure_filename
from resume_parser import ResumeParser
from rag_engine import RAGEngine

load_dotenv()

app = Flask(__name__, static_folder='extension')
CORS(app, resources={r"/api/*": {"origins": "*"}})

UPLOAD_FOLDER = 'uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

resume_parser = ResumeParser()
rag_engine = RAGEngine()

@app.route('/')
def index():
    return jsonify({
        "status": "running",
        "message": "Resume Autofiller API is running",
        "endpoints": {
            "upload_resume": "POST /api/upload",
            "autofill": "POST /api/autofill",
            "answer_hr": "POST /api/answer-hr",
            "get_resume_data": "GET /api/resume-data",
            "health": "GET /api/health"
        }
    })

@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({"status": "healthy", "rag_initialized": rag_engine.is_initialized})

@app.route('/api/upload', methods=['POST'])
def upload_resume():
    if 'file' not in request.files:
        return jsonify({"error": "No file provided"}), 400
    
    file = request.files['file']
    if not file.filename or file.filename == '':
        return jsonify({"error": "No file selected"}), 400
    
    original_filename = secure_filename(file.filename)
    allowed_extensions = {'pdf', 'docx', 'txt'}
    file_ext = original_filename.rsplit('.', 1)[-1].lower() if '.' in original_filename else ''
    
    if file_ext not in allowed_extensions:
        return jsonify({"error": f"File type not supported. Use: {', '.join(allowed_extensions)}"}), 400
    
    safe_filename = f"{uuid.uuid4().hex}.{file_ext}"
    filepath = os.path.join(UPLOAD_FOLDER, safe_filename)
    file.save(filepath)
    
    try:
        parsed_data = resume_parser.parse(filepath, file_ext)
        rag_engine.index_resume(parsed_data)
        
        os.remove(filepath)
        
        return jsonify({
            "success": True,
            "message": "Resume uploaded and indexed successfully",
            "sections_found": list(parsed_data.keys()),
            "preview": {k: v[:200] if isinstance(v, str) else v for k, v in parsed_data.items()}
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/autofill', methods=['POST'])
def autofill():
    data = request.json
    if not data:
        return jsonify({"error": "No data provided"}), 400
    
    field_label = data.get('field_label', '')
    field_type = data.get('field_type', 'text')
    field_context = data.get('context', '')
    existing_value = data.get('existing_value', '')
    
    if not field_label:
        return jsonify({"error": "Field label is required"}), 400
    
    if not rag_engine.is_initialized:
        return jsonify({
            "error": "No resume uploaded yet",
            "needs_manual": True,
            "suggestion": "Please upload your resume first"
        }), 400
    
    try:
        result = rag_engine.get_autofill_value(
            field_label=field_label,
            field_type=field_type,
            context=field_context,
            existing_value=existing_value
        )
        return jsonify(result)
    except Exception as e:
        return jsonify({
            "error": str(e),
            "needs_manual": True,
            "suggestion": f"Please fill '{field_label}' manually"
        }), 500

@app.route('/api/answer-hr', methods=['POST'])
def answer_hr():
    data = request.json
    if not data:
        return jsonify({"error": "No data provided"}), 400
    
    question = data.get('question', '')
    job_context = data.get('job_context', '')
    
    if not question:
        return jsonify({"error": "Question is required"}), 400
    
    if not rag_engine.is_initialized:
        return jsonify({
            "error": "No resume uploaded yet",
            "needs_manual": True
        }), 400
    
    try:
        result = rag_engine.answer_hr_question(question, job_context)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e), "needs_manual": True}), 500

@app.route('/api/resume-data', methods=['GET'])
def get_resume_data():
    if not rag_engine.is_initialized:
        return jsonify({"error": "No resume uploaded"}), 400
    
    return jsonify({
        "success": True,
        "structured_data": rag_engine.get_structured_data()
    })

@app.route('/api/multi-entry', methods=['POST'])
def get_multi_entry():
    data = request.json
    section = data.get('section', '')
    
    if section not in ['education', 'experience', 'projects']:
        return jsonify({"error": "Invalid section. Use: education, experience, projects"}), 400
    
    if not rag_engine.is_initialized:
        return jsonify({"error": "No resume uploaded"}), 400
    
    try:
        entries = rag_engine.get_multi_entries(section)
        return jsonify({"success": True, "entries": entries, "count": len(entries)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
