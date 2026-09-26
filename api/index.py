import os
import io
import json
import base64
import mimetypes
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, render_template, Response, stream_with_context
import requests
from groq import Groq

#DEFINISIKAN BASE_DIR
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

#INISIALISASI APP FLASK
app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, 'templates'),
    static_folder=os.path.join(BASE_DIR, 'static')
)
try:
    from pypdf import PdfReader
    PYPDF_AVAILABLE = True
except ImportError:
    try:
        from PyPDF2 import PdfReader
        PYPDF_AVAILABLE = True
    except ImportError:
        PYPDF_AVAILABLE = False

try:
    from docx import Document
    DOCX_AVAILABLE = True
except ImportError:
    DOCX_AVAILABLE = False

try:
    import openpyxl
    OPENPYXL_AVAILABLE = True
except ImportError:
    OPENPYXL_AVAILABLE = False

try:
    from pptx import Presentation
    PPTX_AVAILABLE = True
except ImportError:
    PPTX_AVAILABLE = False

import requests
from flask import Flask, request, jsonify, render_template, Response, stream_with_context
from groq import Groq

# Perubahan penting: Arahkan template_folder & static_folder ke direktori root (satu tingkat di luar folder api/)
app = Flask(__name__, template_folder='../templates', static_folder='../static')

GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
TEXT_MODEL = os.environ.get("GROQ_MODEL")
VISION_MODEL = os.environ.get("GROQ_VISION_MODEL")

client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

NASA_API_KEY = os.environ.get("NASA_API_KEY")

NASA_EPIC_METADATA_URL = "https://api.nasa.gov/EPIC/api/natural/date/{date}"
NASA_EPIC_IMAGE_URL = "https://api.nasa.gov/EPIC/archive/natural/{yyyy}/{mm}/{dd}/png/{name}.png"

EPIC_LOOKBACK_DAYS = 10
EPIC_REQUEST_TIMEOUT = 10

EARTH_IMAGE_KEYWORDS = [
    "bumi hari ini", "gambar bumi hari ini", "foto bumi hari ini",
    "tampilkan bumi", "lihat bumi", "bumi dari luar angkasa",
    "foto bumi terbaru", "gambar bumi terbaru", "gambar bumi",
    "foto bumi", "epic earth", "nasa earth", "earth today",
    "today's earth", "today earth", "earth from space",
    "view of earth", "planet bumi hari ini",
]

class EpicFetchError(Exception):
    pass

def is_earth_image_intent(message: str) -> bool:
    if not message:
        return False
    text = message.lower().strip()
    return any(keyword in text for keyword in EARTH_IMAGE_KEYWORDS)

def _fetch_epic_metadata_for_date(date_obj):
    date_str = date_obj.strftime("%Y-%m-%d")
    url = NASA_EPIC_METADATA_URL.format(date=date_str)

    try:
        resp = requests.get(url, params={"api_key": NASA_API_KEY}, timeout=EPIC_REQUEST_TIMEOUT)
    except requests.exceptions.Timeout:
        raise EpicFetchError("Waktu koneksi ke server NASA habis (timeout). Silakan coba lagi.")
    except requests.exceptions.ConnectionError:
        raise EpicFetchError("Tidak bisa terhubung ke server NASA. Periksa koneksi internet Anda.")
    except requests.exceptions.RequestException as e:
        raise EpicFetchError(f"Gagal menghubungi NASA EPIC API: {e}")

    if resp.status_code == 429:
        raise EpicFetchError("Batas permintaan (rate limit) API NASA sudah tercapai. Coba lagi nanti.")
    if resp.status_code == 403:
        raise EpicFetchError("API Key NASA tidak valid, belum diset, atau ditolak server.")
    if resp.status_code != 200:
        raise EpicFetchError(f"NASA EPIC API mengembalikan status tidak terduga: {resp.status_code}.")

    try:
        data = resp.json()
    except ValueError:
        raise EpicFetchError("Respons dari NASA EPIC API tidak valid (bukan JSON).")

    if not isinstance(data, list):
        return []
    return data

def _build_epic_result(item, date_obj):
    image_name = item.get("image", "epic_earth")
    caption = item.get("caption") or "Tidak ada caption dari NASA untuk gambar ini."
    date_taken = item.get("date") or date_obj.strftime("%Y-%m-%d %H:%M:%S")

    yyyy, mm, dd = date_obj.strftime("%Y"), date_obj.strftime("%m"), date_obj.strftime("%d")
    image_url = (
        NASA_EPIC_IMAGE_URL.format(yyyy=yyyy, mm=mm, dd=dd, name=image_name)
        + f"?api_key={NASA_API_KEY}"
    )

    return {
        "ok": True,
        "image_name": image_name,
        "image_url": image_url,
        "caption": caption,
        "date": date_taken,
        "date_only": date_obj.strftime("%Y-%m-%d"),
    }

def find_latest_epic_image():
    today = datetime.utcnow().date()
    for offset in range(EPIC_LOOKBACK_DAYS + 1):
        check_date = today - timedelta(days=offset)
        data = _fetch_epic_metadata_for_date(check_date)
        if data:
            return _build_epic_result(data[0], check_date)

    raise EpicFetchError(
        f"Tidak ditemukan gambar Bumi NASA EPIC dalam {EPIC_LOOKBACK_DAYS} hari terakhir."
    )

def get_earth_today_payload():
    try:
        return find_latest_epic_image()
    except EpicFetchError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": f"Terjadi kesalahan tak terduga saat mengambil data NASA: {e}"}

SYSTEM_PROMPT = (
    "Kamu adalah ZUPIUM, asisten AI cerdas, serba bisa, ramah, dan to the point. "
    "Jawab dalam Bahasa Indonesia kecuali user memakai bahasa lain. "
    "Gunakan markdown (heading, list, tabel, **bold**) dan code block ```bahasa``` "
    "saat menjelaskan kode atau tugas supaya rapi dibaca. "
    "Jika user mengirim gambar, deskripsikan dan analisis isinya secara mendetail. "
    "Jika user mengirim file/dokumen (seperti PDF, Word, Excel, PowerPoint, Jupyter Notebook, "
    "atau berbagai format kode pemrograman), baca isinya dengan seksama dan bantu jawab pertanyaan, "
    "perbaiki error, kerjakan tugas, atau buat rangkuman sesuai instruksi user. "
    "Untuk rumus/persamaan matematika, selalu gunakan notasi LaTeX dengan delimiter "
    "\\(... \\) untuk inline dan \\[... \\] untuk blok (atau $$...$$ untuk blok), "
    "termasuk saat memakai lingkungan seperti \\begin{aligned}...\\end{aligned}. "
    "Jangan pernah menampilkan simbol LaTeX mentah di luar delimiter tersebut. "
    "pencipta kamu adalah orang yang biasa di panggil 'GANDHI'"
)

def extract_text_from_pdf(raw_bytes: bytes) -> str:
    if not PYPDF_AVAILABLE:
        return "(Library 'pypdf' belum terpasang di server. Jalankan 'pip install pypdf' di terminal server.)"
    try:
        reader = PdfReader(io.BytesIO(raw_bytes))
        extracted = []
        for idx, page in enumerate(reader.pages):
            page_text = page.extract_text() or ""
            if page_text.strip():
                extracted.append(f"--- Halaman {idx + 1} ---\n{page_text.strip()}")
        if not extracted:
            return "(PDF ini tidak memiliki teks yang bisa diekstrak langsung, kemungkinan hasil scan/gambar.)"
        return "\n\n".join(extracted)
    except Exception as e:
        return f"(Gagal membaca isi dokumen PDF: {e})"

def extract_text_from_docx(raw_bytes: bytes) -> str:
    if not DOCX_AVAILABLE:
        return "(Library 'python-docx' belum terpasang di server. Jalankan 'pip install python-docx' di terminal server.)"
    try:
        doc = Document(io.BytesIO(raw_bytes))
        parts = []
        for p in doc.paragraphs:
            if p.text.strip():
                parts.append(p.text.strip())
        for t_idx, table in enumerate(doc.tables):
            table_lines = []
            for row in table.rows:
                cells = [cell.text.strip().replace("\n", " ") for cell in row.cells]
                table_lines.append(" | ".join(cells))
            if table_lines:
                parts.append(f"[Tabel {t_idx + 1}]\n" + "\n".join(table_lines))
        return "\n\n".join(parts) or "(Dokumen Word kosong)"
    except Exception as e:
        return f"(Gagal membaca file Word: {e})"

def extract_text_from_excel(raw_bytes: bytes) -> str:
    if not OPENPYXL_AVAILABLE:
        return "(Library 'openpyxl' belum terpasang di server. Jalankan 'pip install openpyxl' di terminal server.)"
    try:
        wb = openpyxl.load_workbook(io.BytesIO(raw_bytes), data_only=True)
        sheets_data = []
        for sheetname in wb.sheetnames:
            ws = wb[sheetname]
            rows_data = []
            for row in ws.iter_rows(values_only=True, max_row=150):
                if any(cell is not None for cell in row):
                    cells = [str(cell) if cell is not None else "" for cell in row]
                    while cells and cells[-1] == "":
                        cells.pop()
                    if cells:
                        rows_data.append(" | ".join(cells))
            if rows_data:
                sheets_data.append(f"[Sheet: {sheetname}]\n" + "\n".join(rows_data))
        return "\n\n".join(sheets_data) or "(Spreadsheet Excel kosong)"
    except Exception as e:
        return f"(Gagal membaca file Excel: {e})"

def extract_text_from_pptx(raw_bytes: bytes) -> str:
    if not PPTX_AVAILABLE:
        return "(Library 'python-pptx' belum terpasang di server. Jalankan 'pip install python-pptx' di terminal server.)"
    try:
        prs = Presentation(io.BytesIO(raw_bytes))
        slides_text = []
        for idx, slide in enumerate(prs.slides):
            lines = []
            for shape in slide.shapes:
                if hasattr(shape, "text") and shape.text.strip():
                    lines.append(shape.text.strip())
            if lines:
                slides_text.append(f"[Slide {idx + 1}]\n" + "\n".join(lines))
        return "\n\n".join(slides_text) or "(File PowerPoint kosong)"
    except Exception as e:
        return f"(Gagal membaca file PowerPoint: {e})"

def extract_text_from_ipynb(raw_bytes: bytes) -> str:
    try:
        content = raw_bytes.decode("utf-8", errors="replace")
        nb = json.loads(content)
        cells = nb.get("cells", [])
        output = []
        for idx, cell in enumerate(cells):
            cell_type = cell.get("cell_type", "code")
            src = "".join(cell.get("source", []))
            if not src.strip():
                continue
            if cell_type == "markdown":
                output.append(f"[Sel {idx + 1} - Markdown]\n{src.strip()}")
            elif cell_type == "code":
                output.append(f"[Sel {idx + 1} - Code]\n```python\n{src.strip()}\n```")
        return "\n\n".join(output) or "(Notebook kosong)"
    except Exception as e:
        return f"(Gagal membaca Jupyter Notebook: {e})"

def try_decode_as_text(raw_bytes: bytes):
    for enc in ("utf-8", "utf-8-sig", "latin-1", "cp1252"):
        try:
            text = raw_bytes.decode(enc)
            if "\x00" not in text[:1024]:
                return text
        except UnicodeDecodeError:
            continue
    return None

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg"}

CODE_AND_TEXT_EXTS = {
    ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml",
    ".env", ".ini", ".toml", ".log", ".conf", ".cfg", ".sql", ".tex", ".rtf",
    ".py", ".pyw", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
    ".html", ".htm", ".css", ".scss", ".sass", ".less", ".php",
    ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".cs",
    ".java", ".kt", ".kts", ".swift", ".go", ".rs", ".rb", ".dart",
    ".sh", ".bash", ".zsh", ".bat", ".cmd", ".ps1",
    ".r", ".m", ".lua", ".asm", ".v", ".sv", ".pl", ".pm", ".groovy", ".gradle"
}

MAX_FILE_SIZE = 15 * 1024 * 1024

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "model": TEXT_MODEL, "configured": bool(GROQ_API_KEY)})

@app.route("/api/earth-today")
def earth_today():
    payload = get_earth_today_payload()
    status_code = 200 if payload.get("ok") else 502
    return jsonify(payload), status_code

def build_user_content(user_message, attachments):
    has_image = any(a["kind"] == "image" for a in attachments)

    if not has_image:
        extra_text = ""
        for a in attachments:
            if a["kind"] == "text":
                extra_text += f"\n\n--- Isi file: {a['name']} ---\n{a['text']}\n--- akhir file ---\n"
        return user_message + extra_text, False

    content = []
    if user_message:
        content.append({"type": "text", "text": user_message})

    extra_text = ""
    for a in attachments:
        if a["kind"] == "image":
            content.append({
                "type": "image_url",
                "image_url": {"url": f"data:{a['mime']};base64,{a['data_b64']}"}
            })
        elif a["kind"] == "text":
            extra_text += f"\n\n--- Isi file: {a['name']} ---\n{a['text']}\n--- akhir file ---\n"

    if extra_text:
        if content and content[0]["type"] == "text":
            content[0]["text"] += extra_text
        else:
            content.insert(0, {"type": "text", "text": extra_text.strip()})

    if not content:
        content.append({"type": "text", "text": "(tidak ada teks)"})

    return content, True

@app.route("/api/chat", methods=["POST"])
def chat():
    if not client:
        return jsonify({"error": "GROQ_API_KEY belum diset di server."}), 500

    raw_payload = request.form.get("payload")
    if raw_payload:
        payload = json.loads(raw_payload)
    else:
        payload = request.get_json(force=True) or {}

    user_message = (payload.get("message") or "").strip()
    history = payload.get("history") or []

    attachments = []
    has_image_attachment = False
    for f in request.files.getlist("files"):
        filename = f.filename or "file"
        ext = os.path.splitext(filename)[1].lower()
        raw = f.read()

        if len(raw) > MAX_FILE_SIZE:
            return jsonify({"error": f"File '{filename}' terlalu besar (maks 15MB)."}), 400

        if ext in IMAGE_EXTS:
            mime = mimetypes.guess_type(filename)[0] or "image/png"
            attachments.append({
                "kind": "image",
                "name": filename,
                "mime": mime,
                "data_b64": base64.b64encode(raw).decode("utf-8"),
            })
            has_image_attachment = True
        elif ext == ".pdf":
            file_text = extract_text_from_pdf(raw)
            if len(file_text) > 35000:
                file_text = file_text[:35000] + "\n...(dipotong, dokumen terlalu panjang)..."
            attachments.append({"kind": "text", "name": filename, "text": file_text})
        elif ext in {".docx", ".doc"}:
            file_text = extract_text_from_docx(raw)
            if len(file_text) > 35000:
                file_text = file_text[:35000] + "\n...(dipotong, dokumen terlalu panjang)..."
            attachments.append({"kind": "text", "name": filename, "text": file_text})
        elif ext in {".xlsx", ".xls"}:
            file_text = extract_text_from_excel(raw)
            if len(file_text) > 35000:
                file_text = file_text[:35000] + "\n...(dipotong, spreadsheet terlalu panjang)..."
            attachments.append({"kind": "text", "name": filename, "text": file_text})
        elif ext in {".pptx", ".ppt"}:
            file_text = extract_text_from_pptx(raw)
            if len(file_text) > 35000:
                file_text = file_text[:35000] + "\n...(dipotong, slide terlalu panjang)..."
            attachments.append({"kind": "text", "name": filename, "text": file_text})
        elif ext == ".ipynb":
            file_text = extract_text_from_ipynb(raw)
            if len(file_text) > 35000:
                file_text = file_text[:35000] + "\n...(dipotong, notebook terlalu panjang)..."
            attachments.append({"kind": "text", "name": filename, "text": file_text})
        elif ext in CODE_AND_TEXT_EXTS:
            decoded = try_decode_as_text(raw) or "(gagal membaca isi file teks)"
            if len(decoded) > 35000:
                decoded = decoded[:35000] + "\n...(dipotong, file terlalu panjang)..."
            attachments.append({"kind": "text", "name": filename, "text": decoded})
        else:
            decoded = try_decode_as_text(raw)
            if decoded is not None:
                if len(decoded) > 35000:
                    decoded = decoded[:35000] + "\n...(dipotong, file terlalu panjang)..."
                attachments.append({"kind": "text", "name": filename, "text": decoded})
            else:
                attachments.append({
                    "kind": "text",
                    "name": filename,
                    "text": f"(tipe file '{ext}' berupa data biner yang belum didukung untuk dibaca langsung)",
                })

    if not user_message and not attachments:
        return jsonify({"error": "Pesan kosong."}), 400

    if not user_message and attachments:
        user_message = "Tolong analisis lampiran ini."

    user_content, is_multimodal = build_user_content(user_message, attachments)

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for m in history[-20:]:
        if m.get("role") in ("user", "assistant") and m.get("content"):
            messages.append({"role": m["role"], "content": m["content"]})
    messages.append({"role": "user", "content": user_content})

    model_to_use = VISION_MODEL if has_image_attachment else TEXT_MODEL
    trigger_earth_image = (not has_image_attachment) and is_earth_image_intent(user_message)

    def generate():
        if trigger_earth_image:
            try:
                earth_payload = get_earth_today_payload()
                yield f"data: {json.dumps({'earth_image': earth_payload})}\n\n"
            except Exception as e:
                yield f"data: {json.dumps({'earth_image': {'ok': False, 'error': str(e)}})}\n\n"
            yield f"data: {json.dumps({'done': True})}\n\n"
            return

        try:
            stream = client.chat.completions.create(
                model=model_to_use,
                messages=messages,
                temperature=0.7,
                max_tokens=2048,
                top_p=1,
                stream=True,
            )
            for chunk in stream:
                delta = chunk.choices[0].delta.content
                if delta:
                    yield f"data: {json.dumps({'token': delta})}\n\n"
            yield f"data: {json.dumps({'done': True})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
