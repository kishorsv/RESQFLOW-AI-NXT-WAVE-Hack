import { firebaseProjectId, getWorkspaceAccessToken } from './firebase';

function requireToken(): string {
  const token = getWorkspaceAccessToken();
  if (!token) {
    throw new Error(
      'Google Workspace OAuth session is not active. Click "Sign in with Google" in the top bar to authorize Google Workspace APIs (tokens are stored strictly in memory).'
    );
  }
  return token;
}

async function wsFetch<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const token = requireToken();
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const resp = await fetch(url, { ...init, headers });
  if (!resp.ok) {
    const text = await resp.text();
    let msg = `Google Workspace API HTTP ${resp.status}`;
    try {
      const j = JSON.parse(text);
      msg = j.error?.message || msg;
    } catch {
      if (text) msg = text.slice(0, 260);
    }
    throw new Error(msg);
  }
  return (await resp.json()) as T;
}

// 1. GOOGLE DRIVE
export async function driveListFiles(q?: string) {
  const queryParam = q
    ? `name contains '${q.replace(/'/g, "\\'")}' and trashed = false`
    : 'trashed = false';
  const url = `https://www.googleapis.com/drive/v3/files?pageSize=15&q=${encodeURIComponent(
    queryParam
  )}&fields=files(id,name,mimeType,modifiedTime,webViewLink)`;
  const data = await wsFetch<{ files: any[] }>(url);
  return data.files || [];
}

export async function driveCreateTextFile(name: string, content: string) {
  const token = requireToken();
  const boundary = 'resqflow_drive_boundary_991';
  const metadata = JSON.stringify({ name, mimeType: 'text/plain' });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
  const resp = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );
  if (!resp.ok) throw new Error(`Drive upload failed (HTTP ${resp.status})`);
  return resp.json();
}

// 2. GOOGLE SHEETS
export async function sheetsCreateLog(title: string, rows: string[][]) {
  const created = await wsFetch<any>('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    body: JSON.stringify({ properties: { title } }),
  });
  const spreadsheetId = created.spreadsheetId;
  if (rows.length > 0) {
    await wsFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A1:append?valueInputOption=USER_ENTERED`,
      {
        method: 'POST',
        body: JSON.stringify({ values: rows }),
      }
    );
  }
  return {
    spreadsheetId,
    spreadsheetUrl: created.spreadsheetUrl,
    title,
  };
}

// 3. GMAIL
export async function gmailListMessages(maxResults = 8) {
  const list = await wsFetch<{ messages?: { id: string }[] }>(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}`
  );
  const items = [];
  for (const m of (list.messages || []).slice(0, maxResults)) {
    const detail = await wsFetch<any>(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`
    );
    const hdrs = detail.payload?.headers || [];
    const getH = (n: string) => hdrs.find((h: any) => h.name === n)?.value || '';
    items.push({
      id: m.id,
      subject: getH('Subject') || '(No Subject)',
      from: getH('From'),
      date: getH('Date'),
      snippet: detail.snippet || '',
    });
  }
  return items;
}

export async function gmailSendMessage(to: string, subject: string, bodyText: string) {
  const rfc2822 = `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${bodyText}`;
  const bytes = new TextEncoder().encode(rfc2822);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const raw = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return wsFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw }),
  });
}

// 4. GOOGLE CALENDAR
export async function calendarListUpcoming() {
  const timeMin = new Date().toISOString();
  const data = await wsFetch<{ items?: any[] }>(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(
      timeMin
    )}&maxResults=10&singleEvents=true&orderBy=startTime`
  );
  return data.items || [];
}

export async function calendarCreateBriefing(summary: string, description: string, startIso: string, durationMin = 45) {
  const endIso = new Date(new Date(startIso).getTime() + durationMin * 60_000).toISOString();
  return wsFetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1',
    {
      method: 'POST',
      body: JSON.stringify({
        summary,
        description,
        start: { dateTime: startIso },
        end: { dateTime: endIso },
        conferenceData: {
          createRequest: {
            requestId: `resqflow-${Date.now()}`,
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      }),
    }
  );
}

// 5. GOOGLE DOCS
export async function docsCreateSitrep(title: string, bodyText: string) {
  const created = await wsFetch<any>('https://docs.googleapis.com/v1/documents', {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
  const docId = created.documentId;
  await wsFetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{ insertText: { location: { index: 1 }, text: bodyText } }],
    }),
  });
  return {
    documentId: docId,
    url: `https://docs.google.com/document/d/${docId}/edit`,
    title,
  };
}

// 6. GOOGLE SLIDES
export async function slidesCreateBriefingDeck(title: string, bulletSummary: string) {
  const deck = await wsFetch<any>('https://slides.googleapis.com/v1/presentations', {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
  const presentationId = deck.presentationId;
  const slideId = `slide_summary_${Date.now()}`;
  const boxId = `box_summary_${Date.now()}`;
  await wsFetch(`https://slides.googleapis.com/v1/presentations/${presentationId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        { createSlide: { objectId: slideId, slideLayoutReference: { predefinedLayout: 'BLANK' } } },
        {
          createShape: {
            objectId: boxId,
            shapeType: 'TEXT_BOX',
            elementProperties: {
              pageObjectId: slideId,
              size: { height: { magnitude: 320, unit: 'PT' }, width: { magnitude: 620, unit: 'PT' } },
              transform: { scaleX: 1, scaleY: 1, translateX: 48, translateY: 48, unit: 'PT' },
            },
          },
        },
        { insertText: { objectId: boxId, text: `${title}\n\n${bulletSummary}` } },
      ],
    }),
  });
  return {
    presentationId,
    url: `https://docs.google.com/presentation/d/${presentationId}/edit`,
    title,
  };
}

// 7. GOOGLE TASKS
export async function tasksListDefault() {
  const data = await wsFetch<{ items?: any[] }>(
    'https://tasks.googleapis.com/tasks/v1/lists/@default/tasks?maxResults=15'
  );
  return data.items || [];
}

export async function tasksCreateChecklistItem(title: string, notes: string) {
  return wsFetch('https://tasks.googleapis.com/tasks/v1/lists/@default/tasks', {
    method: 'POST',
    body: JSON.stringify({ title, notes }),
  });
}

// 8. GOOGLE CHAT
export const CHAT_CONFIG_URL = `https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat?project=${firebaseProjectId}`;

export async function chatListSpaces() {
  try {
    const data = await wsFetch<{ spaces?: any[] }>('https://chat.googleapis.com/v1/spaces?pageSize=15');
    return data.spaces || [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${msg}. Note: Google Chat API requires a Google Workspace Business/Enterprise account and an active Chat app configuration in GCP Console (${CHAT_CONFIG_URL}).`
    );
  }
}

export async function chatPostMessage(spaceName: string, text: string) {
  return wsFetch(`https://chat.googleapis.com/v1/${spaceName}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

// 9. GOOGLE FORMS
export async function formsCreateIntakeForm(title: string) {
  const created = await wsFetch<any>('https://forms.googleapis.com/v1/forms', {
    method: 'POST',
    body: JSON.stringify({ info: { title, documentTitle: title } }),
  });
  const formId = created.formId;
  await wsFetch(`https://forms.googleapis.com/v1/forms/${formId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        {
          createItem: {
            item: {
              title: 'Location & Affected Population Summary',
              questionItem: { question: { required: true, textQuestion: { paragraph: true } } },
            },
            location: { index: 0 },
          },
        },
        {
          createItem: {
            item: {
              title: 'Critical Relief Items Needed (Water, Medical, Food, Shelter)',
              questionItem: { question: { required: true, textQuestion: { paragraph: true } } },
            },
            location: { index: 1 },
          },
        },
      ],
    }),
  });
  return {
    formId,
    responderUri: created.responderUri,
    editUrl: `https://docs.google.com/forms/d/${formId}/edit`,
  };
}

// 10. GOOGLE MEET
export async function meetCreateWarRoom() {
  return wsFetch<{ name: string; meetingUri: string; meetingCode: string }>(
    'https://meet.googleapis.com/v2/spaces',
    {
      method: 'POST',
      body: JSON.stringify({}),
    }
  );
}

// 11. GOOGLE CONTACTS (People API)
export async function contactsListDirectory() {
  const data = await wsFetch<{ connections?: any[] }>(
    'https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers,organizations&pageSize=20'
  );
  return (data.connections || []).map((c) => ({
    resourceName: c.resourceName,
    name: c.names?.[0]?.displayName || 'Unnamed Contact',
    email: c.emailAddresses?.[0]?.value || '',
    phone: c.phoneNumbers?.[0]?.value || '',
    org: c.organizations?.[0]?.name || '',
  }));
}
