# Undrwrite Backend

AI-powered private lending underwriting intake system.

## Setup

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and fill in values
3. Run development server: `npm run dev`

## Endpoints

- `GET /health` - Health check
- `POST /webhook/inbound` - Postmark inbound email webhook

## Project Structure

- `src/index.js` - Express server entry point
- `src/routes/` - API route handlers
- `src/services/` - Business logic
- `src/lib/` - External service clients
- `src/prompts/` - AI prompt templates
