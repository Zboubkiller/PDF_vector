# PDF Vector

A self-hosted API that turns PDF pages into **editable vector graphics** and back, built on top of **LibreOffice headless** and **QPDF** — no proprietary PDF SDK involved.

It's the backend behind a "free/libre PDF editor" tool: upload a PDF, get back per-page SVGs plus a structured list of editable text elements, tweak the text, and export a new PDF.

## How it works

The core trick is a **PDF → FODG (LibreOffice Draw XML) → SVG** pipeline:

1. **Split**: a multi-page PDF is split into single-page PDFs with `qpdf`. This is necessary because LibreOffice's SVG/FODG export only ever renders one page's worth of canvas — for a multi-page input it silently overlaps every page into the same area.
2. **Convert**: each single-page PDF is converted with `soffice --headless --convert-to fodg` (for structured, editable XML) and `--convert-to svg` (for a faithful visual preview).
3. **Extract**: the FODG (an OpenDocument Drawing XML dialect) is parsed with `fast-xml-parser` to pull out every text frame — position (`x`/`y`/`width`/`height` in mm) and text content — into a flat JSON list the frontend can render and edit over the SVG preview.
4. **Edit**: the frontend sends back a map of `{ oldText -> newText }` per page.
5. **Re-render**: the API patches the original FODG's XML directly (string replacement, XML-entity aware) and converts the edited FODG back to PDF with `soffice`, then reassembles multi-page documents with `qpdf`.

Each LibreOffice invocation runs with its own throwaway `-env:UserInstallation` profile directory (cleaned up right after), so concurrent conversions don't corrupt each other's LibreOffice user profile/lock files.

A small in-process **job queue** caps how many `soffice`/`qpdf` processes run at once (`MAX_CONCURRENT_JOBS`), so a burst of uploads gets queued with a visible position instead of spawning N LibreOffice instances and starving the server's RAM.

## Endpoints

All conversion endpoints are asynchronous: they return `202 { jobId, position }` immediately, and you poll `/job/:id` until `status` is `done` or `error`.

| Endpoint | Method | Body | Description |
|---|---|---|---|
| `/health` | GET | - | Server status + queue length |
| `/convert` | POST | `multipart/form-data`, field `pdf` | PDF → per-page SVG + editable text elements |
| `/export` | POST | JSON `{ sessionId, pagesModifications }` | Apply text edits and rebuild a PDF |
| `/merge` | POST | `multipart/form-data`, field `pdfs` (2-20 files) | Merge PDFs with `qpdf` |
| `/extract` | POST | `multipart/form-data`, field `pdf` + `pageRange` | Extract a page range (e.g. `1-3,5`) with `qpdf` |
| `/job/:id` | GET | - | Poll job status / result |
| `/job/:id/download` | GET | - | Download the finished file (deletes the session afterward) |

### Quick tutorial

**1. Convert a PDF to editable pages:**

```bash
curl -X POST http://localhost:3005/convert -F "pdf=@document.pdf"
# -> { "jobId": "…", "position": 0 }

curl http://localhost:3005/job/<jobId>
# -> { "status": "done", "type": "convert",
#      "result": { "sessionId": "…", "pageCount": 2, "pages": [ ... ] } }
```

Each entry in `pages[].elements` looks like:

```json
{ "id": "el_0_1", "type": "text", "xMm": 20, "yMm": 15, "wMm": 170, "hMm": 10, "text": "Original text" }
```

**2. Edit text and export a new PDF:**

```bash
curl -X POST http://localhost:3005/export \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "<sessionId from step 1>",
    "pagesModifications": [
      { "el_0_1": { "oldText": "Original text", "newText": "Replaced text" } }
    ]
  }'
# -> { "jobId": "…" }

curl http://localhost:3005/job/<jobId>/download -o edited.pdf
```

**3. Merge or extract pages** work the same way — upload, poll `/job/:id`, then `/job/:id/download`.

## Requirements

- Node.js
- [`qpdf`](https://qpdf.sourceforge.io/) on `PATH`
- LibreOffice (`soffice`) on `PATH`, headless-capable

## Setup

```bash
npm install
PORT=3005 node server.js
```

The server binds to `127.0.0.1` only — it's meant to sit behind a reverse proxy (e.g. nginx) that handles TLS and routes `/pdf-libre-api/*`.

## Design notes

- **Rate limiting**: 20 conversions/day and 6/10min per IP on every endpoint that spawns `soffice`/`qpdf`, to keep the queue usable for everyone.
- **Privacy**: uploaded PDFs, generated SVG/FODG files and exported PDFs live under `/tmp` and are deleted either right after download or by a periodic sweep (1h TTL).
- **qpdf exit code 3**: qpdf returns exit code 3 when it succeeded but had to work around a minor issue (e.g. a slightly malformed xref table) — the wrapper treats that as success rather than failing the whole job.

## License

MIT — see [LICENSE](LICENSE).
