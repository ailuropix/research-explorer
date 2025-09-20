# Research Explorer

A web-based research search application. Enter an author, journal, or topic; the app fetches results via Serper (Google Search API) and generates contextual summaries with Gemini.

## Features
- Search input for author/journal/paper keywords
- Fetches research links (Scholar, arXiv, IEEE, ACM, publishers)
- Clickable results with title, snippet, and "View Paper" button
- Gemini-powered contextual summarization that adapts to the query type

## Tech Stack
- Backend: Node.js + Express
- Search API: Serper (https://serper.dev) — requires API key
- Summarization: Gemini via `@google/generative-ai` — requires Google API key
- Frontend: Vanilla HTML/CSS/JS served from `public/`

## Setup
1. Install Node.js 18+.
2. Create `.env` from example and add keys:
   ```
   cp .env.example .env
   # edit .env to set SERPER_API_KEY and GOOGLE_API_KEY
   ```
3. Install dependencies and run:
   ```
   npm install
   npm run dev
   ```
4. Open http://localhost:3000 in your browser.

## Environment Variables
- `SERPER_API_KEY`: Your Serper API key
- `GOOGLE_API_KEY`: Your Google API key for Gemini
- `PORT` (optional): Port to run the server (default 3000)

## Endpoints
- `POST /api/search` — body `{ query }` → returns normalized list of results
- `POST /api/summarize` — body `{ query, items }` → returns summary text
- `POST /api/query` — body `{ query }` → performs search then summarize

## Notes
- The query classification uses heuristics to guess if the input is an author, journal, or paper/topic. You can refine `classifyQuery()` in `server.js` as needed.
- Be mindful of API usage limits and costs. No keys are stored client-side; all calls are from the server.
