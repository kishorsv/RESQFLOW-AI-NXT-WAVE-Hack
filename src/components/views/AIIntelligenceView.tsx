import React, { useEffect, useRef, useState } from 'react';
import {
  Bot,
  ExternalLink,
  Globe,
  MapPin,
  Mic,
  MicOff,
  Radio,
  Send,
  Upload,
  Volume2,
} from 'lucide-react';
import { apiRequest, getSessionToken } from '../../lib/api';
import type { DataMode, Incident } from '../../shared/types';

interface AIIntelligenceViewProps {
  mode: DataMode;
  incidents: Incident[];
}

interface ChatTurn {
  role: 'user' | 'model';
  text: string;
  modelUsed?: string;
  groundingChunks?: { title: string; uri: string; sourceType: 'web' | 'maps' }[];
}

function pcmFloatToBase64(float32: Float32Array): string {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(int16.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export const AIIntelligenceView: React.FC<AIIntelligenceViewProps> = ({ mode, incidents }) => {
  const [subTab, setSubTab] = useState<'chat' | 'live' | 'transcribe' | 'tts'>('chat');

  // Chat state
  const [chatModel, setChatModel] = useState('gemini-4-hydrogen');
  const [highThinking, setHighThinking] = useState(false);
  const [useSearch, setUseSearch] = useState(true);
  const [useMaps, setUseMaps] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatTurn[]>([
    {
      role: 'model',
      text: 'RESQFLOW AI Command Copilot online. Ask for operational risk briefings, supply shortage triage, Google Search grounded updates, or Google Maps grounded nearby hospitals & shelters.',
      modelUsed: 'system',
    },
  ]);

  // Live Voice API state (gemini-3.8-live)
  const [liveStatus, setLiveStatus] = useState<'idle' | 'connecting' | 'live' | 'error'>('idle');
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveTranscripts, setLiveTranscripts] = useState<{ who: 'operator' | 'ai'; text: string }[]>([]);
  const liveWsRef = useRef<WebSocket | null>(null);
  const inCtxRef = useRef<AudioContext | null>(null);
  const outCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nextStartTimeRef = useRef<number>(0);

  // Audio Transcription state (gemini-3.5-transcribe)
  const [txResult, setTxResult] = useState<string | null>(null);
  const [txLoading, setTxLoading] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);

  // TTS Broadcast state (gemini-3.8-flash-tts)
  const [ttsText, setTtsText] = useState(
    'Attention all Sector 4 field units. Flash flood risk in Velachery lowlands has reached Critical threshold. High-clearance relief convoy RF-TRK-104 is staging potable water and trauma kits for dispatch.'
  );
  const [ttsVoice, setTtsVoice] = useState('Kore');
  const [ttsAudioUrl, setTtsAudioUrl] = useState<string | null>(null);
  const [ttsLoading, setTtsLoading] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);

  const sendChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || chatLoading) return;
    const nextMsgs: ChatTurn[] = [...messages, { role: 'user', text: chatInput.trim() }];
    setMessages(nextMsgs);
    setChatInput('');
    setChatLoading(true);
    setChatError(null);
    try {
      const apiMsgs = nextMsgs
        .filter((m) => m.modelUsed !== 'system')
        .map((m) => ({ role: m.role, text: m.text }));
      const refInc = incidents[0];
      const res = await apiRequest<{
        text: string;
        modelUsed: string;
        groundingChunks: { title: string; uri: string; sourceType: 'web' | 'maps' }[];
      }>('/ai/chat', {
        method: 'POST',
        body: {
          messages: apiMsgs,
          mode,
          model: chatModel,
          highThinking: chatModel === 'gemini-4-carbon' ? highThinking : false,
          useGoogleSearch: useSearch,
          useGoogleMaps: useMaps,
          lat: refInc?.lat ?? 12.9784,
          lng: refInc?.lng ?? 80.2186,
        },
      });
      setMessages((prev) => [
        ...prev,
        {
          role: 'model',
          text: res.text,
          modelUsed: res.modelUsed,
          groundingChunks: res.groundingChunks,
        },
      ]);
    } catch (err) {
      setChatError(err instanceof Error ? err.message : 'Chat failed');
    } finally {
      setChatLoading(false);
    }
  };

  const stopLiveVoice = () => {
    try {
      liveWsRef.current?.close();
    } catch {}
    liveWsRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    inCtxRef.current?.close().catch(() => {});
    outCtxRef.current?.close().catch(() => {});
    inCtxRef.current = null;
    outCtxRef.current = null;
    nextStartTimeRef.current = 0;
    setLiveStatus('idle');
  };

  useEffect(() => {
    return () => stopLiveVoice();
  }, []);

  const startLiveVoice = async () => {
    setLiveError(null);
    setLiveStatus('connecting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const inCtx = new AudioContext({ sampleRate: 16000 });
      const outCtx = new AudioContext({ sampleRate: 24000 });
      inCtxRef.current = inCtx;
      outCtxRef.current = outCtx;
      nextStartTimeRef.current = outCtx.currentTime;

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const tok = getSessionToken();
      const qs = tok ? `?sessionToken=${encodeURIComponent(tok)}` : '';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/live-voice${qs}`);
      liveWsRef.current = ws;

      ws.onopen = () => {
        const source = inCtx.createMediaStreamSource(stream);
        const processor = inCtx.createScriptProcessor(4096, 1, 1);
        source.connect(processor);
        processor.connect(inCtx.destination);
        processor.onaudioprocess = (ev) => {
          if (ws.readyState === WebSocket.OPEN) {
            const b64 = pcmFloatToBase64(ev.inputBuffer.getChannelData(0));
            ws.send(JSON.stringify({ audio: b64 }));
          }
        };
      };

      ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'ready') {
          setLiveStatus('live');
        } else if (msg.type === 'audio' && outCtxRef.current) {
          const bin = atob(msg.audio);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const int16 = new Int16Array(bytes.buffer);
          const float32 = new Float32Array(int16.length);
          for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

          const audioBuf = outCtxRef.current.createBuffer(1, float32.length, 24000);
          audioBuf.copyToChannel(float32, 0);
          const src = outCtxRef.current.createBufferSource();
          src.buffer = audioBuf;
          src.connect(outCtxRef.current.destination);

          const startAt = Math.max(outCtxRef.current.currentTime, nextStartTimeRef.current);
          src.start(startAt);
          nextStartTimeRef.current = startAt + audioBuf.duration;
        } else if (msg.type === 'interrupted' && outCtxRef.current) {
          nextStartTimeRef.current = outCtxRef.current.currentTime;
        } else if (msg.type === 'input_transcript') {
          setLiveTranscripts((prev) => [...prev.slice(-20), { who: 'operator', text: msg.text }]);
        } else if (msg.type === 'output_transcript') {
          setLiveTranscripts((prev) => [...prev.slice(-20), { who: 'ai', text: msg.text }]);
        } else if (msg.type === 'error') {
          setLiveError(msg.message);
          setLiveStatus('error');
        }
      };

      ws.onerror = () => {
        setLiveError('Live Voice WebSocket connection failed.');
        setLiveStatus('error');
      };
      ws.onclose = () => {
        if (liveStatus !== 'error') setLiveStatus('idle');
      };
    } catch (err) {
      setLiveError(err instanceof Error ? err.message : 'Microphone permission or Live API connection failed');
      setLiveStatus('error');
    }
  };

  const handleAudioUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setTxLoading(true);
    setTxError(null);
    setTxResult(null);
    try {
      const base64Data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const res = await apiRequest<{ transcript: string }>('/ai/transcribe', {
        method: 'POST',
        body: { base64Data, mimeType: file.type || 'audio/mp3' },
      });
      setTxResult(res.transcript);
    } catch (err) {
      setTxError(err instanceof Error ? err.message : 'Transcription failed');
    } finally {
      setTxLoading(false);
    }
  };

  const generateBroadcastTts = async () => {
    setTtsLoading(true);
    setTtsError(null);
    setTtsAudioUrl(null);
    try {
      const res = await apiRequest<{ audioBase64: string; mimeType: string }>('/ai/tts', {
        method: 'POST',
        body: { text: ttsText, voiceName: ttsVoice, model: 'gemini-3.8-flash-tts' },
      });
      // Unary generateContent TTS returns complete WAV file directly
      setTtsAudioUrl(`data:${res.mimeType || 'audio/wav'};base64,${res.audioBase64}`);
    } catch (err) {
      setTtsError(err instanceof Error ? err.message : 'TTS generation failed');
    } finally {
      setTtsLoading(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">
            AI Command Copilot, Live Voice &amp; Radio Speech Intelligence
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            100% server-side @google/genai orchestration · Search &amp; Maps Grounding · Gemini 3.8 Live Voice · Field Audio Transcription &amp; TTS
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {(
            [
              ['chat', 'Command Copilot Chat'],
              ['live', 'Live Voice Radio (3.8-live)'],
              ['transcribe', 'Field Audio Transcribe'],
              ['tts', 'Emergency Broadcast TTS'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setSubTab(id)}
              className={`px-3 py-1.5 rounded-lg border font-medium ${
                subTab === id
                  ? 'border-[#5869E8]/50 dark:border-[#6D7CFF]/55 bg-[#5869E8]/10 dark:bg-[#6D7CFF]/16 text-[#5869E8] dark:text-[#A5B0FF]'
                  : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* SUBTAB 1: COMMAND CHATBOT + GROUNDING */}
      {subTab === 'chat' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 overflow-hidden flex flex-col">
          <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center gap-3 text-xs bg-slate-50 dark:bg-slate-950/50">
            <select
              value={chatModel}
              onChange={(e) => setChatModel(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100"
            >
              <option value="gemini-4-hydrogen">gemini-4-hydrogen (Fast Balanced)</option>
              <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite (Ultra Low Latency)</option>
              <option value="gemini-4-neon">gemini-4-neon (Complex Reasoning)</option>
              <option value="gemini-4-carbon">gemini-4-carbon (Deep Tactical Thinking)</option>
            </select>
            {chatModel === 'gemini-4-carbon' && (
              <label className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={highThinking}
                  onChange={(e) => setHighThinking(e.target.checked)}
                />
                ThinkingLevel.HIGH
              </label>
            )}
            <label className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={useSearch}
                onChange={(e) => setUseSearch(e.target.checked)}
              />
              <Globe className="w-3.5 h-3.5 text-cyan-500" />
              Google Search Grounding
            </label>
            <label className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={useMaps}
                onChange={(e) => setUseMaps(e.target.checked)}
              />
              <MapPin className="w-3.5 h-3.5 text-emerald-500" />
              Google Maps Grounding
            </label>
          </div>

          <div className="p-5 space-y-4 max-h-[440px] overflow-y-auto">
            {messages.map((m, idx) => (
              <div
                key={idx}
                className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-2xl rounded-xl p-3.5 text-sm space-y-2 ${
                    m.role === 'user'
                      ? 'bg-cyan-600 text-white'
                      : 'bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-200'
                  }`}
                >
                  <div className="whitespace-pre-wrap leading-relaxed">{m.text}</div>
                  {m.groundingChunks && m.groundingChunks.length > 0 && (
                    <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-1">
                      <div className="text-[11px] font-mono uppercase text-slate-500">Grounded Sources</div>
                      <div className="flex flex-wrap gap-2">
                        {m.groundingChunks.map((c, ci) => (
                          <a
                            key={ci}
                            href={c.uri}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-cyan-600 dark:text-cyan-400 hover:underline"
                          >
                            {c.sourceType === 'maps' ? <MapPin className="w-3 h-3" /> : <Globe className="w-3 h-3" />}
                            {c.title}
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                  {m.modelUsed && m.modelUsed !== 'system' && (
                    <div className="text-[10px] font-mono text-slate-400">{m.modelUsed}</div>
                  )}
                </div>
              </div>
            ))}
            {chatLoading && (
              <div className="text-xs text-slate-500 flex items-center gap-2">
                <Bot className="w-4 h-4 animate-pulse text-cyan-500" />
                Reasoning across RESQFLOW operational state...
              </div>
            )}
            {chatError && (
              <div className="p-3 rounded-lg border border-red-500/40 bg-red-500/10 text-xs text-red-600 dark:text-red-300">
                {chatError}
              </div>
            )}
          </div>

          <form
            onSubmit={sendChat}
            className="p-4 border-t border-slate-200 dark:border-slate-800 flex gap-2 bg-slate-50 dark:bg-slate-950/40"
          >
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="Ask e.g. 'Find nearest emergency hospitals near Velachery flood zone' or 'Summarize our critical trauma kit deficits'..."
              className="flex-1 px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
            />
            <button
              type="submit"
              disabled={chatLoading}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white text-sm font-medium disabled:opacity-60"
            >
              <Send className="w-4 h-4" />
              Send
            </button>
          </form>
        </div>
      )}

      {/* SUBTAB 2: LIVE VOICE RADIO */}
      {subTab === 'live' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-6 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                <Radio className="w-4 h-4 text-cyan-500" />
                Hands-Free Live Voice Command Channel (gemini-3.8-live)
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Full-duplex 16kHz PCM microphone stream → Server WebSocket Bridge → Gapless 24kHz Gemini Native Audio output
              </p>
            </div>
            {liveStatus === 'live' || liveStatus === 'connecting' ? (
              <button
                type="button"
                onClick={stopLiveVoice}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-medium"
              >
                <MicOff className="w-4 h-4" />
                End Voice Channel
              </button>
            ) : (
              <button
                type="button"
                onClick={startLiveVoice}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white text-xs font-medium"
              >
                <Mic className="w-4 h-4" />
                Open Live Voice Channel
              </button>
            )}
          </div>

          <div className="text-xs font-mono text-slate-500">
            Channel Status:{' '}
            <strong
              className={
                liveStatus === 'live'
                  ? 'text-emerald-500'
                  : liveStatus === 'error'
                  ? 'text-red-500'
                  : 'text-slate-400'
              }
            >
              {liveStatus.toUpperCase()}
            </strong>
          </div>

          {liveError && (
            <div className="p-3 rounded-lg border border-red-500/40 bg-red-500/10 text-xs text-red-600 dark:text-red-300">
              {liveError}
            </div>
          )}

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-4 min-h-[180px] space-y-2 text-xs">
            <div className="font-mono text-[11px] uppercase text-slate-500">Live Audio Transcript Log</div>
            {liveTranscripts.length === 0 ? (
              <div className="text-slate-500 py-8 text-center">
                Open the Live Voice Channel and speak naturally to request status briefings or field coordination support.
              </div>
            ) : (
              liveTranscripts.map((t, i) => (
                <div key={i} className={t.who === 'operator' ? 'text-cyan-600 dark:text-cyan-400' : 'text-slate-800 dark:text-slate-200'}>
                  <strong>{t.who === 'operator' ? 'Operator' : 'RESQFLOW Voice'}:</strong> {t.text}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* SUBTAB 3: AUDIO TRANSCRIPTION */}
      {subTab === 'transcribe' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-6 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-white">
              Field Radio &amp; Voice Note Transcription (gemini-3.5-transcribe)
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Upload recorded field audio (MP3, WAV, M4A, WebM) for verbatim transcription and structured hazard/supply extraction
            </p>
          </div>
          <label className="flex flex-col items-center justify-center p-8 rounded-xl border border-dashed border-slate-300 dark:border-slate-700 cursor-pointer hover:border-cyan-500 transition-colors">
            <Upload className="w-6 h-6 text-cyan-500 mb-2" />
            <span className="text-xs font-medium text-slate-700 dark:text-slate-200">
              {txLoading ? 'Transcribing audio via gemini-3.5-transcribe...' : 'Click to upload field audio file'}
            </span>
            <input type="file" accept="audio/*" onChange={handleAudioUpload} className="hidden" />
          </label>
          {txError && (
            <div className="p-3 rounded-lg border border-red-500/40 bg-red-500/10 text-xs text-red-600 dark:text-red-300">
              {txError}
            </div>
          )}
          {txResult && (
            <div className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 text-sm text-slate-800 dark:text-slate-200 whitespace-pre-wrap">
              {txResult}
            </div>
          )}
        </div>
      )}

      {/* SUBTAB 4: EMERGENCY BROADCAST TTS */}
      {subTab === 'tts' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                <Volume2 className="w-4 h-4 text-cyan-500" />
                Emergency Alert Broadcast Synthesizer (gemini-3.8-flash-tts)
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Generates studio-clarity WAV audio briefings for command announcements and field responder broadcasts
              </p>
            </div>
            <select
              value={ttsVoice}
              onChange={(e) => setTtsVoice(e.target.value)}
              className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-900 dark:text-white"
            >
              {['Kore', 'Zephyr', 'Puck', 'Charon', 'Fenrir'].map((v) => (
                <option key={v} value={v}>
                  Voice: {v}
                </option>
              ))}
            </select>
          </div>
          <textarea
            rows={4}
            value={ttsText}
            onChange={(e) => setTtsText(e.target.value)}
            className="w-full p-3 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm text-slate-900 dark:text-white"
          />
          <button
            type="button"
            disabled={ttsLoading}
            onClick={generateBroadcastTts}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white text-xs font-medium disabled:opacity-60"
          >
            <Volume2 className="w-4 h-4" />
            {ttsLoading ? 'Synthesizing WAV Audio...' : 'Generate Emergency Voice Broadcast'}
          </button>
          {ttsError && (
            <div className="p-3 rounded-lg border border-red-500/40 bg-red-500/10 text-xs text-red-600 dark:text-red-300">
              {ttsError}
            </div>
          )}
          {ttsAudioUrl && (
            <div className="pt-2">
              <audio controls src={ttsAudioUrl} className="w-full" />
            </div>
          )}
        </div>
      )}
    </div>
  );
};
