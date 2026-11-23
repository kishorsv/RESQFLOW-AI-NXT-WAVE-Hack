import React, { useEffect, useState } from 'react';
import {
  Calendar,
  CheckSquare,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Mail,
  MessageSquare,
  Presentation,
  StickyNote,
  Trash2,
  Users,
  Video,
} from 'lucide-react';
import {
  createFieldNote,
  deleteFieldNote,
  type FieldNote,
  subscribeFieldNotes,
} from '../../lib/firebase';
import {
  calendarCreateBriefing,
  calendarListUpcoming,
  CHAT_CONFIG_URL,
  chatListSpaces,
  chatPostMessage,
  contactsListDirectory,
  docsCreateSitrep,
  driveCreateTextFile,
  driveListFiles,
  formsCreateIntakeForm,
  gmailListMessages,
  gmailSendMessage,
  meetCreateWarRoom,
  sheetsCreateLog,
  slidesCreateBriefingDeck,
  tasksCreateChecklistItem,
  tasksListDefault,
} from '../../lib/workspace';
import { ConfirmModal } from '../ConfirmModal';
import type { Incident, InventoryStock, ReliefRequest } from '../../shared/types';

interface WorkspaceHubViewProps {
  firebaseUid: string | null;
  hasWorkspaceToken: boolean;
  onSignInGoogle: () => void;
  incidents: Incident[];
  requests: ReliefRequest[];
  inventory: InventoryStock[];
}

export const WorkspaceHubView: React.FC<WorkspaceHubViewProps> = ({
  firebaseUid,
  hasWorkspaceToken,
  onSignInGoogle,
  incidents,
  requests,
  inventory,
}) => {
  const [service, setService] = useState<string>('drive');
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: 'ok' | 'err'; text: string; url?: string } | null>(null);
  const [items, setItems] = useState<any[]>([]);

  // Form states for Workspace actions
  const [emailTo, setEmailTo] = useState('');
  const [emailSubject, setEmailSubject] = useState('RESQFLOW AI Emergency Situation Briefing');
  const [emailBody, setEmailBody] = useState('');
  const [calSummary, setCalSummary] = useState('Emergency Response Operations Sync');
  const [taskTitle, setTaskTitle] = useState('Verify flood corridor access & staging manifests');
  const [chatSpace, setChatSpace] = useState('');
  const [chatText, setChatText] = useState('RESQFLOW Alert: Review pending multi-warehouse allocation approvals.');

  // Field Notes (Firestore — replaces Enterprise-only Keep API)
  const [notes, setNotes] = useState<FieldNote[]>([]);
  const [noteTitle, setNoteTitle] = useState('');
  const [noteContent, setNoteContent] = useState('');

  // Reusable Explicit Confirmation Gate for ALL mutating Workspace calls
  const [confirmState, setConfirmState] = useState<{
    open: boolean;
    title: string;
    description: string;
    confirmLabel: string;
    action: () => Promise<void>;
  } | null>(null);

  useEffect(() => {
    if (!firebaseUid) {
      setNotes([]);
      return;
    }
    return subscribeFieldNotes(firebaseUid, setNotes, (err) =>
      setStatusMsg({ type: 'err', text: `Field Notes sync error: ${err}` })
    );
  }, [firebaseUid]);

  const buildSitrepText = () =>
    [
      `RESQFLOW AI OPERATIONAL SITREP — ${new Date().toISOString()}`,
      `Active Incidents (${incidents.length}):`,
      ...incidents.slice(0, 6).map((i) => `- [${i.severity.toUpperCase()}] ${i.title} (${i.peopleAffected} affected, Risk ${i.riskScore ?? 'N/A'})`),
      '',
      `Open Relief Requests (${requests.length}):`,
      ...requests.slice(0, 6).map((r) => `- [${r.priorityCategory.toUpperCase()} ${r.priorityScore}/100] ${r.locationName} (${r.status})`),
      '',
      `Inventory Shortages: ${inventory.filter((x) => x.availableQty < x.minStock).length} SKU(s) below safety stock.`,
    ].join('\n');

  const requestConfirm = (title: string, description: string, confirmLabel: string, action: () => Promise<void>) => {
    setConfirmState({ open: true, title, description, confirmLabel, action });
  };

  const runConfirmed = async () => {
    if (!confirmState) return;
    setBusy(true);
    setStatusMsg(null);
    try {
      await confirmState.action();
    } catch (err) {
      setStatusMsg({ type: 'err', text: err instanceof Error ? err.message : 'Workspace API action failed' });
    } finally {
      setBusy(false);
      setConfirmState(null);
    }
  };

  const runRead = async (fn: () => Promise<any[]>, label: string) => {
    setBusy(true);
    setStatusMsg(null);
    try {
      const data = await fn();
      setItems(data);
      setStatusMsg({ type: 'ok', text: `Loaded ${data.length} ${label} item(s) live from Google Workspace.` });
    } catch (err) {
      setStatusMsg({ type: 'err', text: err instanceof Error ? err.message : `Failed to load ${label}` });
    } finally {
      setBusy(false);
    }
  };

  const TABS = [
    { id: 'drive', label: 'Drive', icon: FolderOpen },
    { id: 'sheets', label: 'Sheets', icon: FileSpreadsheet },
    { id: 'gmail', label: 'Gmail', icon: Mail },
    { id: 'calendar', label: 'Calendar', icon: Calendar },
    { id: 'docs', label: 'Docs', icon: FileText },
    { id: 'slides', label: 'Slides', icon: Presentation },
    { id: 'tasks', label: 'Tasks', icon: CheckSquare },
    { id: 'chat', label: 'Chat', icon: MessageSquare },
    { id: 'forms', label: 'Forms', icon: FileText },
    { id: 'meet', label: 'Meet', icon: Video },
    { id: 'contacts', label: 'Contacts', icon: Users },
    { id: 'notes', label: 'Field Notes (Firestore)', icon: StickyNote },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">
            Google Workspace Emergency Collaboration Hub
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Client-side OAuth (in-memory token only) across 11 Workspace APIs + Firestore Field Notes · Explicit confirmation before every write/send
          </p>
        </div>
        {!hasWorkspaceToken && (
          <button
            type="button"
            onClick={onSignInGoogle}
            className="px-4 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white text-xs font-medium"
          >
            Authorize Google Workspace via Google Sign-In
          </button>
        )}
      </div>

      {/* Service Tabs */}
      <div className="flex flex-wrap gap-1.5 text-xs">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setService(t.id);
                setItems([]);
                setStatusMsg(null);
              }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-medium ${
                service === t.id
                  ? 'border-[#5869E8]/50 dark:border-[#6D7CFF]/55 bg-[#5869E8]/10 dark:bg-[#6D7CFF]/16 text-[#5869E8] dark:text-[#A5B0FF]'
                  : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>

      {statusMsg && (
        <div
          className={`p-3 rounded-lg border text-xs flex flex-wrap items-center justify-between gap-2 ${
            statusMsg.type === 'ok'
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300'
          }`}
        >
          <span>{statusMsg.text}</span>
          {statusMsg.url && (
            <a
              href={statusMsg.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 underline font-medium"
            >
              Open in Google Workspace <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
        </div>
      )}

      {/* Workspace Active Panel */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-5 space-y-4 text-xs">
        {service === 'drive' && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => runRead(() => driveListFiles(), 'Drive files')}
                className="px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 font-medium"
              >
                List Recent Drive Files
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  requestConfirm(
                    'Upload SITREP Briefing to Google Drive?',
                    'This will create a new plain-text briefing file in your Google Drive containing the active RESQFLOW situation summary.',
                    'Upload to Drive',
                    async () => {
                      const file = await driveCreateTextFile(
                        `RESQFLOW-SITREP-${new Date().toISOString().slice(0, 16)}.txt`,
                        buildSitrepText()
                      );
                      setStatusMsg({ type: 'ok', text: `Uploaded ${file.name} to Drive.`, url: file.webViewLink });
                    }
                  )
                }
                className="px-3.5 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white font-medium"
              >
                Export Current SITREP to Drive
              </button>
            </div>
            {items.length > 0 && (
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {items.map((f) => (
                  <div key={f.id} className="py-2 flex items-center justify-between">
                    <span className="font-medium text-slate-900 dark:text-slate-100">{f.name}</span>
                    {f.webViewLink && (
                      <a href={f.webViewLink} target="_blank" rel="noreferrer" className="text-cyan-500 hover:underline">
                        Open
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {service === 'sheets' && (
          <div className="space-y-3">
            <p className="text-slate-600 dark:text-slate-300">
              Export live RESQFLOW incidents and supply inventory directly into a formatted Google Sheet for inter-agency logistics auditing.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                requestConfirm(
                  'Create Google Sheet Operational Log?',
                  `Creates a new Google Sheet populated with ${incidents.length} incident(s) and ${inventory.length} inventory SKU(s).`,
                  'Create Google Sheet',
                  async () => {
                    const rows = [
                      ['ID', 'Title', 'Type', 'Severity', 'Status', 'People Affected', 'Risk Score'],
                      ...incidents.map((i) => [
                        i.id,
                        i.title,
                        i.type,
                        i.severity,
                        i.status,
                        String(i.peopleAffected),
                        String(i.riskScore ?? 'N/A'),
                      ]),
                    ];
                    const res = await sheetsCreateLog(`RESQFLOW Operational Ledger ${new Date().toISOString().slice(0, 10)}`, rows);
                    setStatusMsg({ type: 'ok', text: `Created Google Sheet "${res.title}".`, url: res.spreadsheetUrl });
                  }
                )
              }
              className="px-4 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white font-medium"
            >
              Export Incidents to New Google Sheet
            </button>
          </div>
        )}

        {service === 'gmail' && (
          <div className="space-y-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => runRead(() => gmailListMessages(8), 'Gmail messages')}
              className="px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 font-medium"
            >
              Load Recent Inbox Messages
            </button>
            <div className="grid gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
              <input
                value={emailTo}
                onChange={(e) => setEmailTo(e.target.value)}
                placeholder="Recipient email (e.g., commander@agency.org)"
                className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
              />
              <input
                value={emailSubject}
                onChange={(e) => setEmailSubject(e.target.value)}
                className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
              />
              <textarea
                rows={4}
                value={emailBody || buildSitrepText()}
                onChange={(e) => setEmailBody(e.target.value)}
                className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
              />
              <button
                type="button"
                disabled={busy || !emailTo.trim()}
                onClick={() =>
                  requestConfirm(
                    'Send Emergency Email via Gmail?',
                    `Recipient: ${emailTo}\nSubject: ${emailSubject}\n\nPlease confirm before transmitting external email.`,
                    'Send Gmail Message',
                    async () => {
                      await gmailSendMessage(emailTo, emailSubject, emailBody || buildSitrepText());
                      setStatusMsg({ type: 'ok', text: `Emergency briefing email sent to ${emailTo}.` });
                    }
                  )
                }
                className="w-fit px-4 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white font-medium disabled:opacity-60"
              >
                Send Briefing via Gmail
              </button>
            </div>
            {items.length > 0 && (
              <div className="divide-y divide-slate-100 dark:divide-slate-800 pt-2">
                {items.map((m) => (
                  <div key={m.id} className="py-2">
                    <div className="font-semibold text-slate-900 dark:text-white">{m.subject}</div>
                    <div className="text-slate-500">{m.from} · {m.snippet}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {service === 'calendar' && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => runRead(() => calendarListUpcoming(), 'Calendar events')}
                className="px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 font-medium"
              >
                List Upcoming Calendar Briefings
              </button>
              <input
                value={calSummary}
                onChange={(e) => setCalSummary(e.target.value)}
                className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white flex-1 min-w-[200px]"
              />
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  requestConfirm(
                    'Schedule Google Calendar Briefing + Meet Link?',
                    `Creates a 45-minute coordination briefing "${calSummary}" starting 15 minutes from now with Google Meet attached.`,
                    'Create Calendar Event',
                    async () => {
                      const startIso = new Date(Date.now() + 15 * 60_000).toISOString();
                      const ev = await calendarCreateBriefing(calSummary, buildSitrepText(), startIso);
                      setStatusMsg({ type: 'ok', text: `Scheduled "${calSummary}".`, url: ev.htmlLink });
                    }
                  )
                }
                className="px-4 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white font-medium"
              >
                Schedule Briefing + Meet
              </button>
            </div>
            {items.map((ev) => (
              <div key={ev.id} className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
                <div className="font-semibold text-slate-900 dark:text-white">{ev.summary}</div>
                <div className="text-slate-500">{ev.start?.dateTime || ev.start?.date}</div>
              </div>
            ))}
          </div>
        )}

        {service === 'docs' && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              requestConfirm(
                'Generate Google Doc SITREP?',
                'Creates a new Google Document in your account pre-filled with the live RESQFLOW operational SITREP.',
                'Create Google Doc',
                async () => {
                  const res = await docsCreateSitrep(`RESQFLOW SITREP ${new Date().toISOString().slice(0, 16)}`, buildSitrepText());
                  setStatusMsg({ type: 'ok', text: `Created Google Doc "${res.title}".`, url: res.url });
                }
              )
            }
            className="px-4 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white font-medium"
          >
            Create Live SITREP in Google Docs
          </button>
        )}

        {service === 'slides' && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              requestConfirm(
                'Generate Executive Google Slides Deck?',
                'Creates a new Google Slides executive briefing deck populated with current incidents and relief requests.',
                'Create Slides Deck',
                async () => {
                  const res = await slidesCreateBriefingDeck(`RESQFLOW Briefing ${new Date().toISOString().slice(0, 10)}`, buildSitrepText());
                  setStatusMsg({ type: 'ok', text: `Created Google Slides deck "${res.title}".`, url: res.url });
                }
              )
            }
            className="px-4 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white font-medium"
          >
            Generate Command Briefing Deck (Slides)
          </button>
        )}

        {service === 'tasks' && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => runRead(() => tasksListDefault(), 'Google Tasks')}
                className="px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 font-medium"
              >
                Load Checklist Tasks
              </button>
              <input
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white flex-1 min-w-[200px]"
              />
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  requestConfirm(
                    'Add Response Action to Google Tasks?',
                    `Adds "${taskTitle}" to your default Google Tasks checklist.`,
                    'Create Task',
                    async () => {
                      await tasksCreateChecklistItem(taskTitle, 'Created from RESQFLOW AI Command Center');
                      setStatusMsg({ type: 'ok', text: `Created Google Task: "${taskTitle}".` });
                    }
                  )
                }
                className="px-4 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white font-medium"
              >
                Add Google Task
              </button>
            </div>
            {items.map((tk) => (
              <div key={tk.id} className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
                <div className="font-medium text-slate-900 dark:text-white">{tk.title}</div>
                <div className="text-slate-500">{tk.status}</div>
              </div>
            ))}
          </div>
        )}

        {service === 'chat' && (
          <div className="space-y-3">
            <div className="text-slate-500">
              Google Chat API requires a Google Workspace Business/Enterprise account and Chat app configuration in{' '}
              <a href={CHAT_CONFIG_URL} target="_blank" rel="noreferrer" className="text-cyan-500 underline">
                Google Cloud Console
              </a>.
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => runRead(() => chatListSpaces(), 'Chat spaces')}
                className="px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 font-medium"
              >
                List Google Chat Spaces
              </button>
              <input
                value={chatSpace}
                onChange={(e) => setChatSpace(e.target.value)}
                placeholder="spaces/AAA..."
                className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
              />
              <input
                value={chatText}
                onChange={(e) => setChatText(e.target.value)}
                className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white flex-1"
              />
              <button
                type="button"
                disabled={busy || !chatSpace.trim()}
                onClick={() =>
                  requestConfirm(
                    'Post Alert to Google Chat Space?',
                    `Posts "${chatText}" to ${chatSpace}.`,
                    'Post Chat Message',
                    async () => {
                      await chatPostMessage(chatSpace.trim(), chatText);
                      setStatusMsg({ type: 'ok', text: `Posted alert to ${chatSpace}.` });
                    }
                  )
                }
                className="px-4 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white font-medium disabled:opacity-60"
              >
                Post to Chat
              </button>
            </div>
          </div>
        )}

        {service === 'forms' && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              requestConfirm(
                'Create Google Form Field Intake Survey?',
                'Creates a new Google Form with structured emergency location and relief-supply intake questions.',
                'Create Google Form',
                async () => {
                  const res = await formsCreateIntakeForm(`RESQFLOW Field Intake — ${new Date().toISOString().slice(0, 10)}`);
                  setStatusMsg({ type: 'ok', text: `Created intake form (ID: ${res.formId}).`, url: res.editUrl });
                }
              )
            }
            className="px-4 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white font-medium"
          >
            Create Field Relief Intake Form
          </button>
        )}

        {service === 'meet' && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              requestConfirm(
                'Launch Instant Google Meet War Room?',
                'Creates a new Google Meet conference space for live emergency responder coordination.',
                'Create Meet Space',
                async () => {
                  const res = await meetCreateWarRoom();
                  setStatusMsg({ type: 'ok', text: `War Room created (${res.meetingCode}).`, url: res.meetingUri });
                }
              )
            }
            className="px-4 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white font-medium"
          >
            Create Instant Google Meet War Room
          </button>
        )}

        {service === 'contacts' && (
          <div className="space-y-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => runRead(() => contactsListDirectory(), 'Google Contacts')}
              className="px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 font-medium"
            >
              Load Agency Directory from Google Contacts
            </button>
            <div className="grid sm:grid-cols-2 gap-2">
              {items.map((c) => (
                <div key={c.resourceName} className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
                  <div className="font-semibold text-slate-900 dark:text-white">{c.name}</div>
                  <div className="text-slate-500">{c.email || c.phone || c.org || 'No contact info'}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {service === 'notes' && (
          <div className="space-y-4">
            <p className="text-slate-500">
              Google Keep API is Enterprise-only (domain-wide delegation). Responder Field Notes are persisted securely in your private Firebase Firestore collection instead.
            </p>
            {!firebaseUid ? (
              <div className="text-amber-600 dark:text-amber-400">
                Sign in with Google to save and sync private Firestore Field Notes.
              </div>
            ) : (
              <>
                <div className="grid gap-2">
                  <input
                    value={noteTitle}
                    onChange={(e) => setNoteTitle(e.target.value)}
                    placeholder="Field Note Title"
                    className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                  />
                  <textarea
                    rows={3}
                    value={noteContent}
                    onChange={(e) => setNoteContent(e.target.value)}
                    placeholder="Record site observations, road blockages, or handover notes..."
                    className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                  />
                  <button
                    type="button"
                    disabled={!noteTitle.trim() || !noteContent.trim()}
                    onClick={async () => {
                      await createFieldNote(firebaseUid, noteTitle, noteContent);
                      setNoteTitle('');
                      setNoteContent('');
                      setStatusMsg({ type: 'ok', text: 'Field note synced to Firestore.' });
                    }}
                    className="w-fit px-4 py-2 rounded-lg bg-[#5869E8] hover:bg-[#4758D6] dark:bg-[#6D7CFF] dark:hover:bg-[#8190FF] text-white font-medium disabled:opacity-60"
                  >
                    Save Field Note to Firestore
                  </button>
                </div>
                <div className="grid sm:grid-cols-2 gap-3">
                  {notes.map((n) => (
                    <div
                      key={n.id}
                      className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 space-y-1"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="font-semibold text-slate-900 dark:text-white">{n.title}</div>
                        <button
                          type="button"
                          onClick={() => deleteFieldNote(n.id)}
                          className="text-slate-400 hover:text-red-500"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <p className="text-slate-600 dark:text-slate-300 whitespace-pre-wrap">{n.content}</p>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <ConfirmModal
        open={Boolean(confirmState?.open)}
        title={confirmState?.title || ''}
        description={confirmState?.description || ''}
        confirmLabel={confirmState?.confirmLabel || 'Confirm'}
        loading={busy}
        onConfirm={runConfirmed}
        onCancel={() => setConfirmState(null)}
      />
    </div>
  );
};
