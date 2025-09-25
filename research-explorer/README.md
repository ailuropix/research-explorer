# Research Explorer with Database

A web-based research paper search application that aggregates results from multiple academic sources including Semantic Scholar, Crossref, and OpenAlex. Now includes PostgreSQL database integration for persistent storage of faculty and publication data.

## Features

- Search for research papers by author, title, or keywords
- View publication details including authors, venue, and year
- Filter and sort search results
- Generate summaries of research topics using AI
- **NEW**: Persistent storage of faculty and publication data
- **NEW**: Admin APIs for faculty and publication management
- **NEW**: Department-level analytics and summaries

## Prerequisites

- Node.js (v14 or higher)
- npm (comes with Node.js)
- Docker (for PostgreSQL database)
- API keys for:
  - Serper API (for web search)
  - Google Generative AI (for summaries)

## Database Setup

### 1. Start PostgreSQL Database

```bash
# Start the PostgreSQL container
npm run db:up
```

This will start a PostgreSQL 16 container with:
- User: `fra_admin`
- Password: `fra_pass`
- Database: `fra_db`
- Port: `5432`

### 2. Create .env file

Copy the example environment file and update with your API keys:

```bash
cp .env.example .env
```

Edit `.env` to include:
```
SERPER_API_KEY=your_serper_api_key
GOOGLE_API_KEY=your_google_ai_key
DATABASE_URL=postgresql://fra_admin:fra_pass@localhost:5432/fra_db?schema=public
```

### 3. Run Database Migration

```bash
# Generate Prisma client
npm run db:generate

# Run initial migration
npm run db:migrate
```

### 4. (Optional) View Database with Prisma Studio

```bash
npm run db:studio
```

## Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd research-explorer
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up the database (see Database Setup above)

4. Start the development server:
   ```bash
   npm run dev
   ```

5. Open your browser and navigate to `http://localhost:8081`

## Configuration

You can customize the following environment variables in the `.env` file:

- `PORT`: Port number for the server (default: 8081)
- `SERPER_API_KEY`: Your Serper API key
- `GOOGLE_API_KEY`: Your Google Generative AI API key
- `DATABASE_URL`: PostgreSQL connection string

## API Endpoints

### Search Endpoints

- `POST /api/search` - General search for papers/topics
- `POST /api/authorPublications` - Get publications for a specific author
- `POST /api/summarize` - Generate AI summary of search results

### Admin Endpoints (NEW)

- `GET /api/faculty?department=<dept>` - List faculty (optional department filter)
- `GET /api/faculty/:id/publications?yearFrom=<year>&yearTo=<year>` - Get publications for a faculty
- `GET /api/admin/summary?department=<dept>` - Get department analytics

## Database Models

The application uses three main models:

1. **Faculty** - Stores faculty information with unique constraint on name+college+department
2. **Publication** - Stores publication data linked to faculty with deduplication
3. **FacultyMetrics** - Stores computed metrics like h-index, citation counts

## Testing Database Integration

1. Start the database: `npm run db:up`
2. Run migrations: `npm run db:migrate`
3. Start the server: `npm run dev`
4. Search for a faculty member (e.g., "Niki Modi" from "Thakur College of Engineering and Technology")
5. The data will be automatically saved to the database
6. Use the admin APIs to retrieve stored data:

```bash
# Get all faculty
curl "http://localhost:8081/api/faculty"

# Get faculty publications
curl "http://localhost:8081/api/faculty/{facultyId}/publications"

# Get department summary
curl "http://localhost:8081/api/admin/summary?department=Artificial%20Intelligence%20and%20Data%20Science"
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License.
