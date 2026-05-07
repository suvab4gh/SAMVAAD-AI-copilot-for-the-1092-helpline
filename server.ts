import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { GoogleGenAI } from '@google/genai';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const PORT = 3000;

// SQLite Setup
let db: Database;
async function initDb() {
  db = await open({
    filename: 'calls.db',
    driver: sqlite3.Database
  });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS calls (
        id TEXT PRIMARY KEY,
        state TEXT CHECK(state IN ('UNVERIFIED','VERIFYING','CONFIRMED','ESCALATED')),
        transcript TEXT,
        llm_json TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// -----------------------------------------------------
// STT Layer
// -----------------------------------------------------
async function stt_stream_chunk(audio_b64: string): Promise<string> {
  if (process.env.MOCK_STT === "1") {
    return "namma ooru hallige neeru baralilla";
  }
  
  if (!process.env.BHASHINI_INFERENCE_KEY || !audio_b64) {
    return "";
  }

  const payload = {
    pipelineTasks: [
      {
        taskType: "asr",
        config: {
          language: { sourceLanguage: "kn" },
          serviceId: "",
          modelId: "",
          audioFormat: "wav",
          samplingRate: 16000
        }
      }
    ],
    inputData: {
      audio: [{ audioContent: audio_b64 }]
    }
  };

  try {
    const res = await fetch(process.env.BHASHINI_ASR_URL || "https://dhruva-api.bhashini.gov.in/services/inference/pipeline", {
      method: "POST",
      headers: {
        "Authorization": process.env.BHASHINI_INFERENCE_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error("STT fetch failed");
    const result = await res.json();
    return result.pipelineResponse[0].output[0].source;
  } catch (e) {
    console.error("STT error:", e);
    return "";
  }
}

// -----------------------------------------------------
// TTS Layer
// -----------------------------------------------------
async function tts_generate(text: string, lang: string): Promise<string> {
  if (process.env.MOCK_TTS === "1" || !process.env.BHASHINI_INFERENCE_KEY) {
    // Return dummy base64 wav
    return "UklGRjIAAABXQVZFZm10IBIAAAABAAEAQB8AAEAfAAABAAgAAABmYWN0BAAAAAAAAABkYXRhAAAAAA==";
  }

  const source_lang = lang === "kannada" ? "kn" : lang === "hindi" ? "hi" : "en";
  const payload = {
    pipelineTasks: [{
      taskType: "tts",
      config: {
        language: { sourceLanguage: source_lang },
        audioFormat: "wav",
        samplingRate: 16000,
        gender: "female"
      }
    }],
    inputData: {
      input: [{ source: text }]
    }
  };

  try {
    const res = await fetch(process.env.BHASHINI_TTS_URL || "https://dhruva-api.bhashini.gov.in/services/inference/pipeline", {
      method: "POST",
      headers: {
        "Authorization": process.env.BHASHINI_INFERENCE_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error("TTS fetch failed");
    const result = await res.json();
    return result.pipelineResponse[0].audio[0].audioContent;
  } catch (e) {
    console.error("TTS error:", e);
    return "UklGRjIAAABXQVZFZm10IBIAAAABAAEAQB8AAEAfAAABAAgAAABmYWN0BAAAAAAAAABkYXRhAAAAAA==";
  }
}

// -----------------------------------------------------
// Prompts Layer
// -----------------------------------------------------
const SYSTEM_PROMPT = `You are SAMVAAD, the 1092 Helpline AI copilot.
Analyze the citizen transcript. Output ONLY valid JSON. No markdown.

JSON Schema:
{
  "intent": "water_issue | road_damage | distress | general_query ...",
  "entities": {"location": "...", "issue_type": "...", "duration": "..."},
  "sentiment": "frustrated | distressed | neutral | angry",
  "urgency": "low | medium | high",
  "confidence": 0-100,
  "language_detected": "kannada | hindi | english",
  "dialect_hint": "north_karnataka | south_karnataka | ...",
  "verification_question": "Ask in citizen's dialect: Did I understand [issue] in [location]? Say yes or no."
}

Examples:

Input: "namma ooru hallige, neeru baralilla, 2 tingalaagide"
Output:
{"intent":"water_issue","entities":{"location":"Hallige","issue_type":"no_water_supply","duration":"2 months"},"sentiment":"frustrated","urgency":"high","confidence":94,"language_detected":"kannada","dialect_hint":"north_karnataka","verification_question":"Nivu Hallige alli 2 tingalaagide neeru baralilla annooda nijaane? Dayavittu haan/illa helisi."}

Input: "yavaagaLu namma mane kere oLagide, ellaru bayatake bartha iddare, nanna magu illa!"
Output:
{"intent":"distress_flood","entities":{"location":"caller_residence","issue_type":"flooding","duration":"ongoing"},"sentiment":"distressed","urgency":"high","confidence":89,"language_detected":"kannada","dialect_hint":"unspecified","verification_question":"Nimage yavaagaLu mane kere oLagide annooda nijaane? Nimage yavaagaLu help beku?"}

Input: "hello, yes, that thing, the pipe, it broke, please send"
Output:
{"intent":"water_issue","entities":{"location":null,"issue_type":"pipe_burst","duration":null},"sentiment":"neutral","urgency":"medium","confidence":45,"language_detected":"english","dialect_hint":null,"verification_question":"Nimage pipe odagide annooda nijaane? Yava jaga?"}

Rules:
- If confidence < 65 OR sentiment == "distressed" -> set urgency "high" and flag for escalation.
- verification_question must be in the same language/dialect as input.
- Output JSON only. Do not wrap in markdown fences.`;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

async function understand(transcript: string, session: CallSession): Promise<any> {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-1.5-flash',
      contents: [
        { role: 'user', parts: [{ text: SYSTEM_PROMPT }, { text: transcript }] }
      ],
      config: {
        responseMimeType: "application/json"
      }
    });
    if (response.text) {
      return JSON.parse(response.text);
    }
  } catch (e: any) {
    console.error("LLM Error:", e.message);
    return {
      intent: "error_fallback",
      entities: { location: "unknown", issue_type: "unknown", duration: "unknown" },
      sentiment: "neutral",
      urgency: "medium",
      confidence: 40,
      language_detected: "english",
      dialect_hint: "",
      verification_question: "I had trouble processing. Did I understand you have an issue?"
    };
  }
  return {};
}

// -----------------------------------------------------
// State Machine
// -----------------------------------------------------
type State = "UNVERIFIED" | "VERIFYING" | "CONFIRMED" | "ESCALATED";

class CallSession {
  state: State = "UNVERIFIED";
  failures: number = 0;
  last_llm: any = {};
  transcript_buffer: string = "";
}

function run_state_machine(session: CallSession, llm: any): [State, string] {
  const confidence = llm?.confidence || 0;
  const sentiment = llm?.sentiment || "";
  const urgency = llm?.urgency || "low";
  
  if (sentiment === "distressed" || urgency === "high" || confidence < 65) {
    session.state = "ESCALATED";
    return ["ESCALATED", "hard_escalation"];
  }
  if (session.failures >= 2) {
    session.state = "ESCALATED";
    return ["ESCALATED", "two_failures"];
  }

  if (session.state === "UNVERIFIED") {
    session.last_llm = llm;
    session.state = "VERIFYING";
    return ["VERIFYING", "ask_citizen"];
  }

  return [session.state, "no_change"];
}

function handle_citizen_reply(session: CallSession, text: string): State {
  const lowerText = text.toLowerCase();
  const yes = ["yes", "haan", "sari", "hau", "correct", "aadre", "ಹೌದು", "ಸರಿ"];
  
  if (yes.some(y => lowerText.includes(y))) {
      session.state = "CONFIRMED";
      return "CONFIRMED";
  }
  
  session.failures += 1;
  if (session.failures >= 2) {
      session.state = "ESCALATED";
      return "ESCALATED";
  }
  
  session.state = "UNVERIFIED";
  return "UNVERIFIED";
}

// -----------------------------------------------------
// Server Setup
// -----------------------------------------------------
async function startServer() {
  await initDb();
  
  const app = express();
  const server = createServer(app);
  
  const wss = new WebSocketServer({ noServer: true });
  
  server.on('upgrade', (request, socket, head) => {
    if (request.url?.startsWith('/ws/')) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });
  
  const sessions: Record<string, CallSession> = {};

  wss.on('connection', (ws: WebSocket, req) => {
    // Extract call_id from url like /ws/123
    const call_id_match = req.url?.match(/\/ws\/([^?]+)/);
    const call_id = call_id_match ? call_id_match[1] : 'unknown';
    
    sessions[call_id] = new CallSession();
    
    // Add to DB initially
    db.run('INSERT OR IGNORE INTO calls (id, state) VALUES (?, ?)', [call_id, 'UNVERIFIED']);

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const mtype = msg.type || "audio_chunk";

        if (mtype === "audio_chunk" || !mtype) {
          const audio_b64 = msg.audio || "";
          const is_final = msg.is_final || false;
          
          let transcript = await stt_stream_chunk(audio_b64);
          
          if (!transcript && process.env.MOCK_STT === "1" && audio_b64 && audio_b64.length > 20) transcript = "namma ooru hallige, neeru baralilla, 2 tingalaagide";
          if (!transcript && msg.demo === "water") transcript = "namma ooru hallige, neeru baralilla, 2 tingalaagide";
          if (!transcript && msg.demo === "fire") transcript = "yavaagaLu namma mane kere oLagide, ellaru bayatake bartha iddare, nanna magu illa!";
          if (!transcript && is_final) transcript = msg.text_fallback || "hello, we need help";

          if (transcript) sessions[call_id].transcript_buffer += " " + transcript;

          if (is_final) {
            let full = sessions[call_id].transcript_buffer.trim();
            if (!full) full = transcript || "namma ooru hallige, neeru baralilla";

            const llm_out = await understand(full, sessions[call_id]);
            const [new_state, action] = run_state_machine(sessions[call_id], llm_out);
            
            await db.run('UPDATE calls SET state = ?, transcript = ?, llm_json = ? WHERE id = ?', [new_state, full, JSON.stringify(llm_out), call_id]);

            if (new_state === "VERIFYING") {
              const tts_b64 = await tts_generate(llm_out.verification_question || "", llm_out.language_detected || "kannada");
              ws.send(JSON.stringify({ type: "VERIFYING", tts_audio: tts_b64, llm: llm_out, state: new_state }));
            } else if (new_state === "ESCALATED") {
              ws.send(JSON.stringify({ type: "ESCALATED", reason: action, llm: llm_out, state: new_state }));
            } else {
              ws.send(JSON.stringify({ type: "INTERIM", transcript: full, llm: llm_out, state: new_state }));
            }
          }
        } else if (mtype === "verification_response") {
           const new_state = handle_citizen_reply(sessions[call_id], msg.text || "");
           await db.run('UPDATE calls SET state = ? WHERE id = ?', [new_state, call_id]);
           ws.send(JSON.stringify({ type: new_state, state: new_state }));
        }
      } catch (e) {
        console.error("WS error:", e);
      }
    });

    ws.on('close', () => {
      delete sessions[call_id];
    });
  });

  // Vite integration
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);
