import React, { useState } from 'react';
import {
  Bot,
  Film,
  Image as ImageIcon,
  Music,
  Play,
  ScanEye,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import { apiRequest } from '../../lib/api';
import type { AgentType, DataMode, StructuredAIAgentOutput } from '../../shared/types';

interface AgentCenterViewProps {
  mode: DataMode;
  tasks: StructuredAIAgentOutput[];
  onRefresh: () => void;
}

const AGENTS: { type: AgentType; label: string; desc: string }[] = [
  { type: 'risk_intelligence', label: 'Risk Intelligence Agent', desc: 'Synthesizes severity, live weather & access deficits' },
  { type: 'priority', label: 'Priority Triage Agent', desc: 'Reviews P=0.30S+0.25N+0.20V+0.15U+0.10A edge cases' },
  { type: 'resource', label: 'Resource Audit Agent', desc: 'Audits warehouse inventory health & shortage SKUs' },
  { type: 'allocation', label: 'Allocation Strategy Agent', desc: 'Evaluates multi-warehouse split plans & unmet demand' },
  { type: 'route', label: 'Route Corridor Agent', desc: 'Assesses delivery corridors & vehicle readiness' },
  { type: 'demand_forecast', label: 'Demand Forecast Agent', desc: 'Projects 12h–48h consumption surge & depletion' },
  { type: 'situation_report', label: 'Executive SITREP Agent', desc: 'Generates structured commander briefing' },
  { type: 'coordination', label: 'Inter-Agency Coordination', desc: 'Identifies cross-org handoffs & eliminates duplication' },
];

export const AgentCenterView: React.FC<AgentCenterViewProps> = ({ mode, tasks, onRefresh }) => {
  const [subTab, setSubTab] = useState<'agents' | 'vision' | 'image' | 'video' | 'music'>('agents');

  // Structured Agents
  const [agentType, setAgentType] = useState<AgentType>('situation_report');
  const [agentModel, setAgentModel] = useState('gemini-4-hydrogen');
  const [agentPrompt, setAgentPrompt] = useState('');
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentErr, setAgentErr] = useState<string | null>(null);
  const [latestOutput, setLatestOutput] = useState<StructuredAIAgentOutput | null>(tasks[0] || null);

  // Vision / Video Evidence Analysis
  const [visionPrompt, setVisionPrompt] = useState(
    'Assess this field photo/video for visible flood depth, damaged infrastructure, road passability hazards, and priority relief items needed.'
  );
  const [visionModel, setVisionModel] = useState('gemini-4-neon');
  const [visionResult, setVisionResult] = useState<string | null>(null);
  const [visionErr, setVisionErr] = useState<string | null>(null);
  const [visionBusy, setVisionBusy] = useState(false);

  // Tactical Image Studio
  const [imgPrompt, setImgPrompt] = useState(
    'Clean tactical infographic diagram of a humanitarian flood relief logistics corridor connecting coastal supply hub, medical depot, and high-ground evacuation shelter, high contrast slate blue style'
  );
  const [imgModel, setImgModel] = useState<'gemini-nano-banana-2.1' | 'gemini-3-pro-image' | 'gemini-3.1-flash-lite-image'>(
    'gemini-nano-banana-2.1'
  );
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [imageSize, setImageSize] = useState<'1K' | '2K' | '4K'>('1K');
  const [editSource, setEditSource] = useState<{ base64: string; mime: string } | null>(null);
  const [imgOutput, setImgOutput] = useState<string | null>(null);
  const [imgErr, setImgErr] = useState<string | null>(null);
  const [imgBusy, setImgBusy] = useState(false);

  // Omni Video Studio (gemini-omni-1.2-flash)
  const [vidPrompt, setVidPrompt] = useState(
    'Aerial drone documentary shot flying over an organized humanitarian relief staging depot with emergency vehicles loading water supplies at dawn'
  );
  const [vidAspect, setVidAspect] = useState<'16:9' | '9:16'>('16:9');
  const [vidSource, setVidSource] = useState<{ base64: string; mime: string } | null>(null);
  const [vidOutput, setVidOutput] = useState<string | null>(null);
  const [vidErr, setVidErr] = useState<string | null>(null);
  const [vidBusy, setVidBusy] = useState(false);

  // Lyria Music Studio
  const [musicPrompt, setMusicPrompt] = useState(
    'Calm, focused ambient documentary briefing underscore with subtle synth pulses, 30 seconds, suitable for emergency operations situational awareness video'
  );
  const [musicModel, setMusicModel] = useState<'lyria-3-clip-preview' | 'lyria-3-pro-preview'>('lyria-3-clip-preview');
  const [musicOutput, setMusicOutput] = useState<{ url: string; lyrics: string } | null>(null);
  const [musicErr, setMusicErr] = useState<string | null>(null);
  const [musicBusy, setMusicBusy] = useState(false);

  const readFileBase64 = (file: File) =>
    new Promise<{ base64: string; mime: string }>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () =>
        resolve({ base64: String(reader.result).split(',')[1] || '', mime: file.type || 'image/png' });
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  const executeAgent = async () => {
    setAgentBusy(true);
    setAgentErr(null);
    try {
      const res = await apiRequest<{ task: StructuredAIAgentOutput }>('/ai/agent', {
        method: 'POST',
        body: {
          agentType,
          mode,
          model: agentModel,
          highThinking: agentModel === 'gemini-4-carbon',
          prompt: agentPrompt,
        },
      });
      setLatestOutput(res.task);
      onRefresh();
    } catch (err) {
      setAgentErr(err instanceof Error ? err.message : 'Agent execution failed');
    } finally {
      setAgentBusy(false);
    }
  };

  const handleVisionUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setVisionBusy(true);
    setVisionErr(null);
    setVisionResult(null);
    try {
      const { base64, mime } = await readFileBase64(file);
      const res = await apiRequest<{ analysis: string }>('/ai/analyze-media', {
        method: 'POST',
        body: { base64Data: base64, mimeType: mime, prompt: visionPrompt, model: visionModel },
      });
      setVisionResult(res.analysis);
    } catch (err) {
      setVisionErr(err instanceof Error ? err.message : 'Visual analysis failed');
    } finally {
      setVisionBusy(false);
    }
  };

  const generateImage = async () => {
    setImgBusy(true);
    setImgErr(null);
    try {
      const res = await apiRequest<{ imageDataUrl: string }>('/ai/image', {
        method: 'POST',
        body: {
          prompt: imgPrompt,
          model: imgModel,
          aspectRatio,
          imageSize,
          sourceImageBase64: editSource?.base64,
          sourceMimeType: editSource?.mime,
        },
      });
      setImgOutput(res.imageDataUrl);
    } catch (err) {
      setImgErr(err instanceof Error ? err.message : 'Image generation failed');
    } finally {
      setImgBusy(false);
    }
  };

  const generateVideo = async () => {
    setVidBusy(true);
    setVidErr(null);
    try {
      const res = await apiRequest<{ videoDataUrl: string | null; videoUri: string | null }>('/ai/video', {
        method: 'POST',
        body: {
          prompt: vidPrompt,
          aspectRatio: vidAspect,
          sourceImageBase64: vidSource?.base64,
          sourceMimeType: vidSource?.mime,
        },
      });
      setVidOutput(res.videoDataUrl || res.videoUri);
    } catch (err) {
      setVidErr(err instanceof Error ? err.message : 'Video generation failed');
    } finally {
      setVidBusy(false);
    }
  };

  const generateAudioTrack = async () => {
    setMusicBusy(true);
    setMusicErr(null);
    try {
      const res = await apiRequest<{ audioDataUrl: string; lyrics: string }>('/ai/music', {
        method: 'POST',
        body: { prompt: musicPrompt, model: musicModel },
      });
      setMusicOutput({ url: res.audioDataUrl, lyrics: res.lyrics });
    } catch (err) {
      setMusicErr(err instanceof Error ? err.message : 'Music generation failed');
    } finally {
      setMusicBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">
            Multi-Agent Command Center &amp; Multimodal Evidence Studio
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            8 Zod-validated decision-support agents (requires_approval: true) + Vision/Video Analyzer, Image Studio, Omni Video &amp; Lyria
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          {(
            [
              ['agents', '8 Command Agents'],
              ['vision', 'Image/Video Analyzer'],
              ['image', 'Image Gen / Edit'],
              ['video', 'Omni Video / Animate'],
              ['music', 'Lyria Audio'],
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

      {/* TAB 1: 8 STRUCTURED AGENTS */}
      {subTab === 'agents' && (
        <div className="grid lg:grid-cols-3 gap-5">
          <div className="space-y-3">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 space-y-3">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Select Specialist Agent</div>
              <div className="space-y-1.5">
                {AGENTS.map((ag) => (
                  <button
                    key={ag.type}
                    type="button"
                    onClick={() => setAgentType(ag.type)}
                    className={`w-full text-left p-2.5 rounded-lg border text-xs transition-colors ${
                      agentType === ag.type
                        ? 'border-cyan-500 bg-cyan-500/10 text-slate-900 dark:text-white'
                        : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:border-slate-400'
                    }`}
                  >
                    <div className="font-semibold">{ag.label}</div>
                    <div className="text-[11px] text-slate-500">{ag.desc}</div>
                  </button>
                ))}
              </div>
              <select
                value={agentModel}
                onChange={(e) => setAgentModel(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-900 dark:text-white"
              >
                <option value="gemini-4-hydrogen">gemini-4-hydrogen (Default)</option>
                <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite</option>
                <option value="gemini-4-neon">gemini-4-neon</option>
                <option value="gemini-4-carbon">gemini-4-carbon (High Thinking)</option>
              </select>
              <textarea
                rows={2}
                value={agentPrompt}
                onChange={(e) => setAgentPrompt(e.target.value)}
                placeholder="Optional custom commander directive..."
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-900 dark:text-white"
              />
              <button
                type="button"
                disabled={agentBusy}
                onClick={executeAgent}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white text-xs font-medium disabled:opacity-60"
              >
                <Play className="w-3.5 h-3.5" />
                {agentBusy ? 'Running Structured Agent...' : 'Run Agent'}
              </button>
              {agentErr && <div className="text-xs text-red-500">{agentErr}</div>}
            </div>
          </div>

          <div className="lg:col-span-2 space-y-4">
            {latestOutput ? (
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-800 pb-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                    <Bot className="w-4 h-4 text-cyan-500" />
                    {latestOutput.agent_type.replace(/_/g, ' ').toUpperCase()}
                  </div>
                  <div className="text-xs font-mono text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4" />
                    REQUIRES HUMAN APPROVAL · {latestOutput.model_used}
                  </div>
                </div>
                <p className="text-sm text-slate-800 dark:text-slate-200 leading-relaxed">{latestOutput.summary}</p>
                <div className="space-y-2.5">
                  <div className="text-xs font-semibold uppercase text-slate-500">Structured Recommendations</div>
                  {latestOutput.recommendations.map((rec, i) => (
                    <div
                      key={i}
                      className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 space-y-1"
                    >
                      <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 uppercase">
                        {rec.priority} · {rec.title}
                      </div>
                      <div className="text-sm text-slate-900 dark:text-white">{rec.action}</div>
                      <div className="text-xs text-slate-500">{rec.rationale}</div>
                    </div>
                  ))}
                </div>
                <div className="grid sm:grid-cols-2 gap-3 text-xs">
                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 space-y-1">
                    <div className="font-semibold text-slate-700 dark:text-slate-300">Evidence &amp; Source IDs</div>
                    <ul className="list-disc list-inside text-slate-600 dark:text-slate-400">
                      {latestOutput.evidence.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                    <div className="font-mono text-[11px] text-slate-500 pt-1">
                      IDs: {latestOutput.source_ids.join(', ') || 'None'}
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 space-y-1">
                    <div className="font-semibold text-slate-700 dark:text-slate-300">
                      Uncertainty ({latestOutput.uncertainty.level.toUpperCase()}) &amp; Missing Data
                    </div>
                    <p className="text-slate-600 dark:text-slate-400">{latestOutput.uncertainty.notes}</p>
                    {latestOutput.missing_information.length > 0 && (
                      <div className="text-amber-600 dark:text-amber-400 pt-1">
                        Missing: {latestOutput.missing_information.join('; ')}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-10 text-center text-sm text-slate-500">
                Select any of the 8 specialist agents on the left and click &ldquo;Run Agent&rdquo; to produce a grounded, Zod-validated operational recommendation.
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: VISION / VIDEO EVIDENCE ANALYZER */}
      {subTab === 'vision' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-slate-900 dark:text-white flex items-center gap-2">
              <ScanEye className="w-4 h-4 text-cyan-500" />
              Field Image &amp; Video Damage Assessment Analyzer
            </h2>
            <select
              value={visionModel}
              onChange={(e) => setVisionModel(e.target.value)}
              className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-900 dark:text-white"
            >
              <option value="gemini-4-neon">gemini-4-neon (High Accuracy Vision)</option>
              <option value="gemini-4-hydrogen">gemini-4-hydrogen (Fast Vision)</option>
            </select>
          </div>
          <textarea
            rows={2}
            value={visionPrompt}
            onChange={(e) => setVisionPrompt(e.target.value)}
            className="w-full p-3 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-900 dark:text-white"
          />
          <label className="flex flex-col items-center justify-center p-8 rounded-xl border border-dashed border-slate-300 dark:border-slate-700 cursor-pointer hover:border-cyan-500">
            <Upload className="w-6 h-6 text-cyan-500 mb-2" />
            <span className="text-xs font-medium text-slate-700 dark:text-slate-200">
              {visionBusy ? 'Analyzing field media...' : 'Upload incident photo or short video clip (PNG, JPG, MP4, WebM)'}
            </span>
            <input type="file" accept="image/*,video/*" onChange={handleVisionUpload} className="hidden" />
          </label>
          {visionErr && <div className="text-xs text-red-500">{visionErr}</div>}
          {visionResult && (
            <div className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 text-sm text-slate-800 dark:text-slate-200 whitespace-pre-wrap">
              {visionResult}
            </div>
          )}
        </div>
      )}

      {/* TAB 3: IMAGE GEN / EDIT */}
      {subTab === 'image' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-6 space-y-4">
          <h2 className="text-base font-semibold text-slate-900 dark:text-white flex items-center gap-2">
            <ImageIcon className="w-4 h-4 text-cyan-500" />
            Tactical Briefing Image Generation &amp; Editing Studio
          </h2>
          <div className="grid sm:grid-cols-3 gap-3 text-xs">
            <select
              value={imgModel}
              onChange={(e) => setImgModel(e.target.value as any)}
              className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
            >
              <option value="gemini-nano-banana-2.1">gemini-nano-banana-2.1</option>
              <option value="gemini-3-pro-image">gemini-3-pro-image</option>
              <option value="gemini-3.1-flash-lite-image">gemini-3.1-flash-lite-image</option>
            </select>
            <select
              value={aspectRatio}
              onChange={(e) => setAspectRatio(e.target.value)}
              className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
            >
              {['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'].map((ar) => (
                <option key={ar} value={ar}>
                  Aspect Ratio: {ar}
                </option>
              ))}
            </select>
            <select
              value={imageSize}
              onChange={(e) => setImageSize(e.target.value as '1K' | '2K' | '4K')}
              className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
            >
              {(['1K', '2K', '4K'] as const).map((sz) => (
                <option key={sz} value={sz}>
                  Resolution: {sz}
                </option>
              ))}
            </select>
          </div>
          <textarea
            rows={3}
            value={imgPrompt}
            onChange={(e) => setImgPrompt(e.target.value)}
            className="w-full p-3 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-900 dark:text-white"
          />
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer text-slate-700 dark:text-slate-300">
              <Upload className="w-3.5 h-3.5" />
              {editSource ? 'Reference Image Loaded (Edit Mode)' : 'Optional: Upload Base Image to Edit'}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) setEditSource(await readFileBase64(f));
                }}
              />
            </label>
            <button
              type="button"
              disabled={imgBusy}
              onClick={generateImage}
              className="px-4 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white font-medium disabled:opacity-60"
            >
              {imgBusy ? 'Rendering Visual...' : editSource ? 'Edit Image' : 'Generate Image'}
            </button>
          </div>
          {imgErr && <div className="text-xs text-red-500">{imgErr}</div>}
          {imgOutput && <img src={imgOutput} alt="Generated tactical visual" className="rounded-xl max-h-96 border border-slate-700" />}
        </div>
      )}

      {/* TAB 4: OMNI VIDEO GENERATION / ANIMATION */}
      {subTab === 'video' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-slate-900 dark:text-white flex items-center gap-2">
              <Film className="w-4 h-4 text-cyan-500" />
              Emergency Briefing Video &amp; Image Animator (gemini-omni-1.2-flash)
            </h2>
            <select
              value={vidAspect}
              onChange={(e) => setVidAspect(e.target.value as '16:9' | '9:16')}
              className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-900 dark:text-white"
            >
              <option value="16:9">Landscape 16:9</option>
              <option value="9:16">Portrait 9:16</option>
            </select>
          </div>
          <textarea
            rows={3}
            value={vidPrompt}
            onChange={(e) => setVidPrompt(e.target.value)}
            className="w-full p-3 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-900 dark:text-white"
          />
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer text-slate-700 dark:text-slate-300">
              <Upload className="w-3.5 h-3.5" />
              {vidSource ? 'Starting Frame Loaded (Animate Mode)' : 'Optional: Upload Starting Frame Image'}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) setVidSource(await readFileBase64(f));
                }}
              />
            </label>
            <button
              type="button"
              disabled={vidBusy}
              onClick={generateVideo}
              className="px-4 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white font-medium disabled:opacity-60"
            >
              {vidBusy ? 'Generating Video via Omni Interactions API...' : 'Generate Video'}
            </button>
          </div>
          {vidErr && <div className="text-xs text-red-500">{vidErr}</div>}
          {vidOutput && <video controls src={vidOutput} className="rounded-xl max-h-96 w-full bg-black" />}
        </div>
      )}

      {/* TAB 5: LYRIA MUSIC */}
      {subTab === 'music' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-slate-900 dark:text-white flex items-center gap-2">
              <Music className="w-4 h-4 text-cyan-500" />
              Briefing Audio Underscore Studio (Lyria 3)
            </h2>
            <select
              value={musicModel}
              onChange={(e) => setMusicModel(e.target.value as any)}
              className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-900 dark:text-white"
            >
              <option value="lyria-3-clip-preview">lyria-3-clip-preview (30s Clip)</option>
              <option value="lyria-3-pro-preview">lyria-3-pro-preview (Full Track)</option>
            </select>
          </div>
          <textarea
            rows={3}
            value={musicPrompt}
            onChange={(e) => setMusicPrompt(e.target.value)}
            className="w-full p-3 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-900 dark:text-white"
          />
          <button
            type="button"
            disabled={musicBusy}
            onClick={generateAudioTrack}
            className="px-4 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white text-xs font-medium disabled:opacity-60"
          >
            {musicBusy ? 'Composing Audio Track...' : 'Generate Audio Track'}
          </button>
          {musicErr && <div className="text-xs text-red-500">{musicErr}</div>}
          {musicOutput && (
            <div className="space-y-2">
              <audio controls src={musicOutput.url} className="w-full" />
              {musicOutput.lyrics && (
                <div className="text-xs text-slate-500 whitespace-pre-wrap">{musicOutput.lyrics}</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
