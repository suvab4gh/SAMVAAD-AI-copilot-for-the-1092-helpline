# SAMVAAD — 1092 Helpline AI Copilot

SAMVAAD is an AI-powered helpline copilot that handles citizen audio calls in local dialects, transcribes them, extracts structured intent via Gemini, and runs a state-machine verification loop before escalating to a human agent.

This repository contains both the React frontend and the Express/WebSocket backend integrated into a single runnable full-stack application.

## Prerequisites

- Node.js (v18 or higher recommended)
- API Keys for Google Gemini (and optionally Bhashini for real STT/TTS)

## Getting Started on Your Local Machine

### 1. Download the Code
Clone the repository to your local machine:

```bash
git clone <repository_url>
cd samvaad
```

### 2. Install Dependencies
Install all the required Node.js packages using npm:

```bash
npm install
```

### 3. Environment Variables
Create a `.env` file in the root directory. You can copy the template from `.env.example`:

```bash
cp .env.example .env
```

Open `.env` and configure your API keys:
```env
# Required: Your Google Gemini API Key
GEMINI_API_KEY=your_gemini_api_key_here

# Optional: Bhashini Keys for real STT/TTS (Mock mode is enabled by default)
BHASHINI_INFERENCE_KEY=your-inference-api-key
BHASHINI_ASR_URL=https://dhruva-api.bhashini.gov.in/services/inference/pipeline
BHASHINI_TTS_URL=https://dhruva-api.bhashini.gov.in/services/inference/pipeline

# By default, mock STT/TTS is enabled so you can test without Bhashini keys
MOCK_STT=1
MOCK_TTS=1
```

### 4. Run the Development Server
Start the full-stack development server. This will launch both the Express WebSocket backend and the Vite React frontend.

```bash
npm run dev
```

### 5. Open the Application
Open your browser and navigate to:
[http://localhost:3000](http://localhost:3000)

## How It Works

1. **Audio Capture**: The React frontend captures your microphone in 2-second chunks and sends them via WebSocket to the server.
2. **STT (Speech-to-Text)**: The server passes the audio to Bhashini (or uses a mock fallback).
3. **LLM Layer**: Once the user stops speaking, the accumulated transcript is sent to Google Gemini 1.5 Flash to extract a structured JSON intent (Location, Issue, Urgency, etc.).
4. **State Machine**: The server evaluates the urgency and confidence. It either directly escalates to a human agent or generates a follow-up TTS question to verify the details with the citizen.
5. **Dashboard**: The React UI updates in real-time to show the agent the exact state of the call, the transcript, and the structured intelligence.

## Running in Production

To build and run the optimized production version locally or on a standard VPS:

```bash
npm run build
npm start
```

## Deployment to Vercel

If you'd like to deploy this application to Vercel, note that **Vercel's Serverless environment does not support long-running WebSockets**, which the `backend` uses heavily. 

For the simplest cloud deployment of standard WebSocket + SQLite architecture, a container-based service like [Railway](https://railway.app/), [Render](https://render.com/), or [Fly.io](https://fly.io/) is strongly recommended over Vercel. 

However, you can deploy the React frontend separately. A `vercel.json` file is included in this repository to configure Vercel to just build and serve the static React frontend from `dist` if deployed there. If deploying the frontend to Vercel, you will need to host your Node/Express server elsewhere and update the WebSocket URL in `src/App.tsx` to point to your new backend.
