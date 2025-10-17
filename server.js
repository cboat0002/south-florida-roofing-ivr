const express = require('express');
const moment = require('moment-timezone');

// ----------------------
// South Florida Roofing IVR
//
// This server implements a simple interactive voice response (IVR) flow
// for South Florida Roofing (All Phase Roofing) using Avaya CPaaS
// InboundXML. The logic follows the requirements specified by the user
// (sales/service/billing, after‑hours, urgency detection, etc.).
//
// Environment variable SERVER_BASE_URL should be set to the public URL
// where this server is reachable. Avaya CPaaS will call the various
// endpoints based on this base URL. For local testing you can use
// ngrok or similar to expose your local server and set SERVER_BASE_URL
// accordingly.
//
// To run:
//   npm install
//   SERVER_BASE_URL="https://<your-public-url>" npm start
//
// The server uses an in‑memory Map to store session information keyed
// by CallSid. In a production system you should replace this with a
// persistent data store.

const app = express();
app.use(express.urlencoded({ extended: true }));

// Storage for call sessions. Each session holds caller data as we gather it.
const sessions = new Map();
// Map recording IDs to a tuple of callSid and the field name being captured.
const recordingIndex = new Map();

// Helper: escape XML special characters in user‑provided text.
function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Helper: build an InboundXML document wrapper.
function buildXml(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

// Helper: generate a <Say> tag. Accepts a string or array of strings.
function say(text, options = {}) {
  const { voice = 'alice', language = 'en-US' } = options;
  // Avaya CPaaS uses the same voice parameters as Twilio. 'alice' is the only
  // supported voice for EN‑US at this time.
  const content = Array.isArray(text) ? text.join(' ') : text;
  return `<Say voice="${voice}" language="${language}">${escapeXml(content)}</Say>`;
}

// Helper: create a <Gather> tag for collecting digits or speech.
// action: URL to post results to.
// numDigits: optional, how many digits to collect (DTMF). For speech input
// we don't limit the length; Avaya will send the full speech text.
// hints: optional speech hints to improve recognition.
function gather(action, { prompts, numDigits, hints, language = 'en-US' } = {}) {
  const promptsXml = prompts
    .map(p => say(p, { language }))
    .join('');
  const input = numDigits ? 'dtmf' : 'speech dtmf';
  const numDigitsAttr = numDigits ? ` numDigits="${numDigits}"` : '';
  const hintsAttr = hints ? ` hints="${hints.join(',')}"` : '';
  return `<Gather input="${input}"${numDigitsAttr}${hintsAttr} language="${language}" action="${action}">${promptsXml}</Gather>`;
}

// Helper: create a <Record> tag for capturing caller voice and optionally
// transcribing it. The transcription results will be posted to
// /ivr/transcribe with relevant metadata.
function record(action, { maxLength = 30, playBeep = true, language = 'en-US', transcriptionField }) {
  // Avaya CPaaS transcribe boolean sends transcription to transcribeCallback URL.
  return `<Record action="${action}" method="POST" maxLength="${maxLength}" playBeep="${playBeep}" transcribe="true" transcribeCallback="${process.env.SERVER_BASE_URL}/ivr/transcribe" />`;
}

// Check if current time is within business hours (Mon–Fri 7:00–17:00 ET).
function isBusinessHours() {
  const now = moment().tz('America/New_York');
  const day = now.isoWeekday(); // 1=Monday, 7=Sunday
  const hour = now.hour() + now.minute() / 60;
  // Holiday detection could be added here.
  return day >= 1 && day <= 5 && hour >= 7 && hour < 17;
}

// Determine if description contains urgent keywords.
function checkUrgency(text) {
  const keywords = ['leak', 'leaking', 'storm', 'storm damage', 'emergency', 'tarp', 'ceiling wet', 'water coming in', 'collapse', 'sagging roof'];
  const lc = text.toLowerCase();
  return keywords.some(k => lc.includes(k));
}

// Generate a summary string for logging and demonstration.
function logSummary(session, department) {
  const timestamp = moment().tz('America/New_York').format('YYYY-MM-DD HH:mm:ss');
  const priority = session.priority || 'Normal';
  const name = session.name || 'Unknown';
  const phone = session.phone || 'Unknown';
  const address = session.address || 'Unknown';
  let summary;
  if (department === 'Sales') {
    summary = `Sales | ${name} | ${phone} | ${address} | ${session.description || ''} | ${session.callbackTime || ''} | ${timestamp}`;
  } else if (department === 'Service') {
    summary = `Service | ${name} | ${phone} | ${address} | ${session.issue || ''} | Priority: ${priority} | ${timestamp}`;
  } else if (department === 'Billing') {
    summary = `Office | ${name} | ${phone} | ${session.reason || ''} | ${timestamp}`;
  } else if (department === 'AfterHours') {
    summary = `After-Hours | ${name} | ${phone} | ${address} | ${session.message || ''} | Priority: ${priority} | ${timestamp}`;
  }
  console.log(summary);
}

// Entry point: initial call.
app.post('/ivr/entry', (req, res) => {
  const callSid = req.body.CallSid;
  // Initialize session
  sessions.set(callSid, {});
  let xml;
  if (!isBusinessHours()) {
    // After hours: route to after hours handler.
    const prompts = [
      'You have reached South Florida Roofing after business hours.',
      'We are open Monday through Friday, seven A M to five P M.',
      'Please leave your name, phone number, address, and a brief message about how we can help.',
      'If this is an emergency, for example an active roof leak or storm damage, please mention that so we can mark your message as urgent.'
    ];
    xml = gather(`${process.env.SERVER_BASE_URL}/ivr/afterhours`, { prompts, hints: ['leak', 'service', 'sales', 'billing'] });
  } else {
    // Main greeting and menu.
    const prompts = [
      'Hello, and thank you for calling South Florida Roofing, the virtual assistant for All Phase Roofing.',
      'Our office hours are Monday through Friday, from seven A M to five P M.',
      'For Sales, press one.',
      'For Service, press two.',
      'For Billing or anything else, press three.',
      'You can also just tell me what you need. For example, say, I’d like a roof estimate, or I need to report a leak.',
      'How can I help you today?'
    ];
    xml = gather(`${process.env.SERVER_BASE_URL}/ivr/menu`, { prompts, hints: ['sales', 'service', 'billing', 'estimate', 'leak', 'storm'] });
  }
  res.type('text/xml').send(buildXml(xml));
});

// Menu handler: determine department based on DTMF or speech input.
app.post('/ivr/menu', (req, res) => {
  const callSid = req.body.CallSid;
  const digits = req.body.Digits;
  const speech = (req.body.SpeechResult || '').toLowerCase();
  let nextUrl;
  let department;
  if (digits) {
    if (digits === '1') {
      department = 'Sales';
    } else if (digits === '2') {
      department = 'Service';
    } else {
      department = 'Billing';
    }
  } else if (speech) {
    if (speech.includes('sales') || speech.includes('estimate') || speech.includes('inspection') || speech.includes('roof replacement')) {
      department = 'Sales';
    } else if (speech.includes('service') || speech.includes('leak') || speech.includes('repair') || speech.includes('storm')) {
      department = 'Service';
    } else {
      department = 'Billing';
    }
  } else {
    department = 'Billing';
  }
  // Store department in session
  const session = sessions.get(callSid) || {};
  session.department = department;
  sessions.set(callSid, session);
  // Route to first step of the chosen flow
  switch (department) {
    case 'Sales':
      nextUrl = `${process.env.SERVER_BASE_URL}/ivr/sales/name`;
      break;
    case 'Service':
      nextUrl = `${process.env.SERVER_BASE_URL}/ivr/service/name`;
      break;
    default:
      nextUrl = `${process.env.SERVER_BASE_URL}/ivr/billing/name`;
      break;
  }
  const response = buildXml(`<Redirect method="POST">${nextUrl}</Redirect>`);
  res.type('text/xml').send(response);
});

// ---- Sales Flow ----
app.post('/ivr/sales/name', (req, res) => {
  const callSid = req.body.CallSid;
  const prompts = [
    'To get started, could I please have your full name?'
  ];
  const gatherXml = gather(`${process.env.SERVER_BASE_URL}/ivr/sales/name/save`, { prompts, hints: [] });
  res.type('text/xml').send(buildXml(gatherXml));
});

app.post('/ivr/sales/name/save', (req, res) => {
  const callSid = req.body.CallSid;
  const session = sessions.get(callSid) || {};
  const name = req.body.SpeechResult || req.body.RecordingUrl || req.body.Digits;
  if (name) session.name = name.trim();
  sessions.set(callSid, session);
  const prompts = [
    `Thank you ${session.name}. Could you please provide the property address?`
  ];
  const gatherXml = gather(`${process.env.SERVER_BASE_URL}/ivr/sales/address/save`, { prompts });
  res.type('text/xml').send(buildXml(gatherXml));
});

app.post('/ivr/sales/address/save', (req, res) => {
  const callSid = req.body.CallSid;
  const session = sessions.get(callSid) || {};
  const address = req.body.SpeechResult || req.body.RecordingUrl || req.body.Digits;
  if (address) session.address = address.trim();
  sessions.set(callSid, session);
  const prompts = ['Thank you. Please enter the best phone number to reach you on the keypad.'];
  // Expect 10 digits for US numbers
  const gatherXml = gather(`${process.env.SERVER_BASE_URL}/ivr/sales/phone/save`, { prompts, numDigits: 10 });
  res.type('text/xml').send(buildXml(gatherXml));
});

app.post('/ivr/sales/phone/save', (req, res) => {
  const callSid = req.body.CallSid;
  const session = sessions.get(callSid) || {};
  const phone = req.body.Digits;
  if (phone) session.phone = phone.trim();
  sessions.set(callSid, session);
  const prompts = ['Finally, could you briefly describe what you need? For example, roof replacement, new roof, inspection, or upgrade.'];
  const gatherXml = gather(`${process.env.SERVER_BASE_URL}/ivr/sales/description/save`, { prompts });
  res.type('text/xml').send(buildXml(gatherXml));
});

app.post('/ivr/sales/description/save', (req, res) => {
  const callSid = req.body.CallSid;
  const session = sessions.get(callSid) || {};
  const description = req.body.SpeechResult || req.body.RecordingUrl || req.body.Digits;
  if (description) session.description = description.trim();
  sessions.set(callSid, session);
  const prompts = ['If you have a preferred time for us to call you back, please say it now, or press any key to skip.'];
  const gatherXml = gather(`${process.env.SERVER_BASE_URL}/ivr/sales/callback/save`, { prompts });
  res.type('text/xml').send(buildXml(gatherXml));
});

app.post('/ivr/sales/callback/save', (req, res) => {
  const callSid = req.body.CallSid;
  const session = sessions.get(callSid) || {};
  // If the caller pressed a key (Digits), we skip capturing callback time
  if (req.body.Digits) {
    session.callbackTime = '';
  } else {
    const cb = req.body.SpeechResult;
    session.callbackTime = cb ? cb.trim() : '';
  }
  sessions.set(callSid, session);
  // Log summary
  logSummary(session, 'Sales');
  // Thank you message and end
  const farewell = [
    'Thank you. I’ll forward this to our Sales team so they can schedule your free estimate.',
    'Thank you for calling South Florida Roofing. We appreciate your business and will be in touch soon.'
  ];
  const xml = say(farewell);
  res.type('text/xml').send(buildXml(xml));
});

app.post('/ivr/service/name', (req, res) => {
  const callSid = req.body.CallSid;
  const prompts = ['I’m sorry you’re having an issue. Could I please have your full name?'];
  const gatherXml = gather(`${process.env.SERVER_BASE_URL}/ivr/service/name/save`, { prompts });
  res.type('text/xml').send(buildXml(gatherXml));
});

app.post('/ivr/service/name/save', (req, res) => {
  const callSid = req.body.CallSid;
  const session = sessions.get(callSid) || {};
  const name = req.body.SpeechResult || req.body.Digits;
  if (name) session.name = name.trim();
  sessions.set(callSid, session);
  const prompts = ['Could you please provide the service address?'];
  const gatherXml = gather(`${process.env.SERVER_BASE_URL}/ivr/service/address/save`, { prompts });
  res.type('text/xml').send(buildXml(gatherXml));
});

app.post('/ivr/service/address/save', (req, res) => {
  const callSid = req.body.CallSid;
  const session = sessions.get(callSid) || {};
  const address = req.body.SpeechResult || req.body.Digits;
  if (address) session.address = address.trim();
  sessions.set(callSid, session);
  const prompts = ['Please enter the best phone number to reach you on the keypad.'];
  const gatherXml = gather(`${process.env.SERVER_BASE_URL}/ivr/service/phone/save`, { prompts, numDigits: 10 });
  res.type('text/xml').send(buildXml(gatherXml));
});

app.post('/ivr/service/phone/save', (req, res) => {
  const callSid = req.body.CallSid;
  const session = sessions.get(callSid) || {};
  const phone = req.body.Digits;
  if (phone) session.phone = phone.trim();
  sessions.set(callSid, session);
  const prompts = ['Please describe the issue you are experiencing.'];
  // For issue description we want speech input; record for transcription
  const xml = record(`${process.env.SERVER_BASE_URL}/ivr/service/issue/save`, { maxLength: 60, transcriptionField: 'issue' });
  // Prepend prompt
  const response = buildXml(`${say(prompts)}${xml}`);
  res.type('text/xml').send(response);
});

app.post('/ivr/service/issue/save', (req, res) => {
  const callSid = req.body.CallSid;
  const session = sessions.get(callSid) || {};
  // After the record, Avaya posts the recording URL to this endpoint. We can't
  // get the transcription yet; the transcribe callback will update it.
  session.recordingSid = req.body.RecordingSid;
  recordingIndex.set(req.body.RecordingSid, { callSid, field: 'issue' });
  sessions.set(callSid, session);
  // Determine preliminary priority (we will update again when transcription arrives)
  const issue = '';
  session.priority = 'Normal';
  sessions.set(callSid, session);
  // Thank you message
  const farewell = [
    'Thank you. I’ll mark this as urgent if necessary and have our Service team contact you as soon as possible.',
    'Thank you for calling South Florida Roofing. We appreciate your business and will be in touch soon.'
  ];
  res.type('text/xml').send(buildXml(say(farewell)));
});

// ---- Billing/General Flow ----
app.post('/ivr/billing/name', (req, res) => {
  const callSid = req.body.CallSid;
  const prompts = ['Could I have your full name?'];
  const gatherXml = gather(`${process.env.SERVER_BASE_URL}/ivr/billing/name/save`, { prompts });
  res.type('text/xml').send(buildXml(gatherXml));
});

app.post('/ivr/billing/name/save', (req, res) => {
  const callSid = req.body.CallSid;
  const session = sessions.get(callSid) || {};
  const name = req.body.SpeechResult || req.body.Digits;
  if (name) session.name = name.trim();
  sessions.set(callSid, session);
  const prompts = ['Please enter the best phone number to reach you on the keypad.'];
  const gatherXml = gather(`${process.env.SERVER_BASE_URL}/ivr/billing/phone/save`, { prompts, numDigits: 10 });
  res.type('text/xml').send(buildXml(gatherXml));
});

app.post('/ivr/billing/phone/save', (req, res) => {
  const callSid = req.body.CallSid;
  const session = sessions.get(callSid) || {};
  const phone = req.body.Digits;
  if (phone) session.phone = phone.trim();
  sessions.set(callSid, session);
  const prompts = ['Please briefly describe how we can help, for example billing, scheduling, vendor, or general question.'];
  const gatherXml = gather(`${process.env.SERVER_BASE_URL}/ivr/billing/reason/save`, { prompts });
  res.type('text/xml').send(buildXml(gatherXml));
});

app.post('/ivr/billing/reason/save', (req, res) => {
  const callSid = req.body.CallSid;
  const session = sessions.get(callSid) || {};
  const reason = req.body.SpeechResult || req.body.Digits;
  if (reason) session.reason = reason.trim();
  sessions.set(callSid, session);
  logSummary(session, 'Billing');
  const farewell = [
    'Thank you. I’ll make sure our office team gets this message and follows up shortly.',
    'Thank you for calling South Florida Roofing. We appreciate your business and will be in touch soon.'
  ];
  res.type('text/xml').send(buildXml(say(farewell)));
});

// ---- After Hours Flow ----
app.post('/ivr/afterhours', (req, res) => {
  const callSid = req.body.CallSid;
  const prompts = ['Please say your name, phone number, address, and a brief message.'];
  const xml = record(`${process.env.SERVER_BASE_URL}/ivr/afterhours/save`, { maxLength: 90 });
  const response = buildXml(`${say(prompts)}${xml}`);
  res.type('text/xml').send(response);
});

app.post('/ivr/afterhours/save', (req, res) => {
  const callSid = req.body.CallSid;
  const session = sessions.get(callSid) || {};
  session.recordingSid = req.body.RecordingSid;
  recordingIndex.set(req.body.RecordingSid, { callSid, field: 'message' });
  session.department = 'AfterHours';
  sessions.set(callSid, session);
  // Thank you message
  const farewell = [
    'Thank you. We will return your call first thing the next business day.',
    'Thank you for calling South Florida Roofing. We appreciate your business and will be in touch soon.'
  ];
  res.type('text/xml').send(buildXml(say(farewell)));
});

// ---- Transcription Callback ----
// Avaya CPaaS will post transcribed text here after a <Record> completes.
app.post('/ivr/transcribe', (req, res) => {
  // The RecordingSid identifies which session and field the transcription belongs to.
  const recordingSid = req.body.RecordingSid;
  const transcriptionText = req.body.TranscriptionText || '';
  const mapping = recordingIndex.get(recordingSid);
  if (mapping) {
    const { callSid, field } = mapping;
    const session = sessions.get(callSid) || {};
    session[field] = transcriptionText;
    // Check urgency for service and after hours
    if (field === 'issue' || field === 'message') {
      session.priority = checkUrgency(transcriptionText) ? 'Urgent' : 'Normal';
    }
    sessions.set(callSid, session);
    // If the transcription is for service or after hours, log the summary now.
    if (session.department === 'Service' && field === 'issue') {
      logSummary(session, 'Service');
    }
    if (session.department === 'AfterHours' && field === 'message') {
      logSummary(session, 'AfterHours');
    }
    recordingIndex.delete(recordingSid);
  }
  res.sendStatus(200);
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`South Florida Roofing IVR listening on port ${PORT}`);
});
