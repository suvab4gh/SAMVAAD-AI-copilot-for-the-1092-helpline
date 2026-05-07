import { useEffect, useState, useRef } from 'react';

interface LLMData {
  intent: string;
  entities: { location: string; issue_type: string; duration: string };
  sentiment: string;
  urgency: string;
  confidence: number;
  language_detected: string;
  dialect_hint: string;
  verification_question: string;
}

export default function App() {
  const callId = useRef(`call-${Math.floor(Math.random() * 10000)}`);
  const [state, setState] = useState("UNVERIFIED");
  const [transcript, setTranscript] = useState("");
  const [llm, setLlm] = useState<LLMData | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const mediaRecorder = useRef<MediaRecorder | null>(null);

  useEffect(() => {
    // Connect WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws.current = new WebSocket(`${protocol}//${window.location.host}/ws/${callId.current}`);
    
    ws.current.onmessage = (event) => {
      const data = JSON.parse(event.data);
      console.log("WS Received:", data);
      
      if (data.state) setState(data.state);
      if (data.transcript) setTranscript(data.transcript);
      if (data.llm) setLlm(data.llm);

      // Auto-play TTS verification question
      if (data.tts_audio && data.tts_audio !== "UklGRjIAAABXQVZFZm10IBIAAAABAAEAQB8AAEAfAAABAAgAAABmYWN0BAAAAAAAAABkYXRhAAAAAA==") {
        const audio = new Audio(`data:audio/wav;base64,${data.tts_audio}`);
        audio.play().catch(e => console.log("Audio play failed", e));
      } else if (data.llm?.verification_question) {
        // Fallback to browser TTS for demo video when mock audio is received
        // To be safe, wait a brief moment
        setTimeout(() => {
          const utterance = new SpeechSynthesisUtterance(data.llm.verification_question);
          const voices = window.speechSynthesis.getVoices();
          utterance.voice = voices.find(v => v.lang.includes('kn') || v.lang.includes('hi') || v.lang.includes('en-IN')) || null;
          window.speechSynthesis.speak(utterance);
        }, 300);
      }
    };

    return () => ws.current?.close();
  }, []);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder.current = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      
      mediaRecorder.current.ondataavailable = async (e) => {
        if (e.data.size > 0 && ws.current?.readyState === WebSocket.OPEN) {
          const buffer = await e.data.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
          const base64 = btoa(binary);
          
          ws.current.send(JSON.stringify({
            type: 'audio_chunk',
            audio: base64,
            is_final: false
          }));
        }
      };

      mediaRecorder.current.start(2000); // 2-second chunks
      setState("RECORDING");
    } catch (err) {
      console.error("Microphone access denied or error:", err);
      alert("Could not start recording. Please check microphone permissions.");
    }
  };

  const stopAndSend = () => {
    if (mediaRecorder.current && mediaRecorder.current.state !== "inactive") {
      mediaRecorder.current.stop();
      // Stop all audio tracks
      mediaRecorder.current.stream.getTracks().forEach(track => track.stop());
    }
    setState("PROCESSING");
    
    // Send final flag on last chunk
    setTimeout(() => {
      if (ws.current?.readyState === WebSocket.OPEN) {
        ws.current.send(JSON.stringify({ type: 'audio_chunk', audio: '', is_final: true }));
      }
    }, 500);
  };

  const sendVerification = (text: string) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: 'verification_response', text }));
    }
  };

  // For testing the WS connection
  const invokeDemoSequence = (demoType: "water" | "fire") => {
    setState("PROCESSING");
    setTranscript("");
    setLlm(null);
    
    // Simulate real network STT latency for the video
    setTimeout(() => {
        if (ws.current?.readyState === WebSocket.OPEN) {
           ws.current.send(JSON.stringify({ 
             type: 'audio_chunk',
             audio: "dummy-audio", 
             is_final: true, 
             demo: demoType 
           }));
        }
    }, 1500);
  };

  return (
    <div className="h-screen bg-slate-900 text-white p-6 grid grid-cols-2 gap-4 font-sans">
      <div className="col-span-2 flex justify-between items-center mb-2">
         <h1 className="text-2xl font-bold tracking-tight">SAMVAAD | 1092 AI Copilot</h1>
         <div className="flex gap-2">
            <button onClick={startRecording} disabled={state === "RECORDING"} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded text-sm font-bold shadow-lg shadow-emerald-500/20 disabled:opacity-50">Start Call (Mic)</button>
            <button onClick={stopAndSend} disabled={state !== "RECORDING"} className="px-4 py-2 bg-slate-600 hover:bg-slate-500 rounded text-sm font-bold shadow-lg disabled:opacity-50">Stop & Process</button>
            <span className="w-px h-8 bg-slate-700 mx-2"></span>
            <button onClick={() => invokeDemoSequence("water")} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded text-sm font-bold shadow-lg shadow-indigo-500/20">Demo: Water</button>
            <button onClick={() => invokeDemoSequence("fire")} className="px-4 py-2 bg-red-600 hover:bg-red-500 rounded text-sm font-bold shadow-lg shadow-red-500/20">Demo: Fire</button>
         </div>
      </div>

      {/* LEFT: Live Audio & Transcript */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 flex flex-col">
        <h2 className="text-xl font-bold mb-4 flex items-center gap-2">Live Transcript</h2>
        <div className="h-40 bg-slate-700 rounded flex items-center justify-center mb-4 border border-slate-600 shadow-inner">
          <span className={`font-mono tracking-widest ${state === 'RECORDING' ? 'text-emerald-400 animate-pulse' : 'text-slate-400'}`}>
            {state === 'RECORDING' ? '[ AUDIO STREAM ACTIVE ]' : '[ MIC INACTIVE ]'}
          </span>
        </div>
        <p className="text-lg bg-slate-900 flex-1 p-4 rounded border border-slate-700 font-serif italic text-slate-300 relative">
          {transcript || "Waiting for citizen..."}
        </p>
      </div>

      {/* RIGHT: AI Interpretation */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 flex flex-col">
        <h2 className="text-xl font-bold mb-4">AI Interpretation</h2>
        <div className="bg-slate-900 flex-1 rounded border border-slate-700 p-4">
        {llm ? (
          <div className="space-y-3 text-sm">
            <div className="flex justify-between border-b border-slate-800 pb-1">
              <span className="text-slate-400 uppercase text-[10px] tracking-widest">Intent</span>
              <span className="font-mono text-cyan-400 font-bold">{llm.intent}</span>
            </div>
            <div className="flex justify-between border-b border-slate-800 pb-1">
              <span className="text-slate-400 uppercase text-[10px] tracking-widest">Location</span>
              <span className="font-mono text-slate-200">{llm.entities?.location || "?"}</span>
            </div>
            <div className="flex justify-between border-b border-slate-800 pb-1">
              <span className="text-slate-400 uppercase text-[10px] tracking-widest">Issue Type</span>
              <span className="font-mono text-slate-200">{llm.entities?.issue_type}</span>
            </div>
            <div className="flex justify-between border-b border-slate-800 pb-1">
              <span className="text-slate-400 uppercase text-[10px] tracking-widest">Sentiment</span>
              <span className={`font-bold uppercase ${llm.sentiment==='distressed'?'text-red-500':'text-emerald-400'}`}>{llm.sentiment}</span>
            </div>
            <div className="flex justify-between border-b border-slate-800 pb-1">
              <span className="text-slate-400 uppercase text-[10px] tracking-widest">Urgency</span>
              <span className={llm.urgency==='high'?'text-red-400 font-bold uppercase':'text-emerald-400 font-bold uppercase'}>{llm.urgency}</span>
            </div>
            <div className="flex justify-between border-b border-slate-800 pb-1">
              <span className="text-slate-400 uppercase text-[10px] tracking-widest">Confidence</span>
              <span className={llm.confidence < 65 ? 'text-red-500 font-bold font-mono' : 'text-emerald-400 font-bold font-mono'}>{llm.confidence}%</span>
            </div>
            <div className="flex justify-between pb-1">
              <span className="text-slate-400 uppercase text-[10px] tracking-widest">Language</span>
              <span className="text-slate-300 capitalize">{llm.language_detected} <span className="text-slate-500 font-mono text-[10px]">({llm.dialect_hint})</span></span>
            </div>
            {llm.verification_question && (
              <div className="mt-4 p-4 bg-indigo-900/30 border border-indigo-500/50 rounded shadow-inner text-sm italic font-serif text-indigo-200">
                "{llm.verification_question}"
              </div>
            )}
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-slate-600 font-mono text-sm">
             [ WAITING FOR AI PROCESSING ]
          </div>
        )}
        </div>
      </div>

      {/* STATE BAR */}
      <div className="col-span-2 text-center py-4 rounded-xl font-bold text-2xl tracking-widest shadow-lg border border-white/10 transition-colors duration-500 flex items-center justify-center"
        style={{
          backgroundColor: 
            state === "CONFIRMED" ? "#16a34a" :
            state === "ESCALATED" ? "#dc2626" :
            state === "VERIFYING" ? "#ca8a04" :
            state === "PROCESSING" ? "#3b82f6" : "#1e293b"
        }}>
        STATE: {state} {state === "PROCESSING" && <span className="ml-4 w-6 h-6 border-4 border-white/30 border-t-white rounded-full animate-spin"></span>}
      </div>
      
      {state === "VERIFYING" && (
        <div className="col-span-2 flex justify-center gap-4 bg-slate-800 py-3 rounded border border-slate-700 animate-pulse">
          <p className="flex items-center text-slate-400 mr-4">Waiting for citizen confirmation...</p>
          <button onClick={() => sendVerification("haan sari")} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded text-sm font-bold">Simulate YES</button>
          <button onClick={() => sendVerification("illa")} className="px-4 py-2 bg-red-600 hover:bg-red-500 rounded text-sm font-bold">Simulate NO</button>
        </div>
      )}

      {state === "ESCALATED" && (
        <div className="col-span-2 bg-red-600 text-white text-center py-3 rounded font-bold animate-pulse shadow-lg shadow-red-600/50 tracking-widest">
          AGENT INTERVENTION REQUIRED — FULL CONTEXT LOGGED
        </div>
      )}
    </div>
  );
}
