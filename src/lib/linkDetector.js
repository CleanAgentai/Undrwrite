// ──────────────────────────────────────────────────────────────────────────
// ADMIN-HANDOFF LINK-SUBMISSION feature (2026-05-20):
// detectFileHostingLinksInBody — pure detection of well-known file-hosting
// service URLs in an inbound broker email body.
// ──────────────────────────────────────────────────────────────────────────
// Trigger surface: broker sends an inbound email with a file-hosting link
// in the body and ZERO attachments. Vienna can't fetch the link (no URL-
// fetching for security/scope reasons), so the deal hands off to admin
// for manual action.
//
// ARCHITECTURE: detection-only. No URL fetching, no link-following, no
// content access. The detected URL + service identifier are passed to the
// admin-handoff notification template so admin can open the link manually.
//
// SIG-STRIP FIRST (mirrors C.7's parseBrokerFirstNameFromSignature
// discipline): split on the RFC sig delimiter `\n-- \n` and run detection
// on the prefix only. Eliminates signature-block link false-positives by
// construction — a broker who has a Dropbox link in their email signature
// (unrelated to this submission) won't trigger the handoff branch.
//
// PATTERNS: ten regex patterns covering six well-known file-hosting
// services. Each pattern is verbatim against the service's public link
// format (provenance noted per pattern). NO speculative coverage; first
// match wins (deterministic dispatch).
//
// SCOPE-LOCKS:
//   - Conservative service list. Uncommon services (mediafire, sendspace,
//     mega.nz, file.io, pcloud, etc.) NOT covered → fail SAFE to the
//     existing "please attach the documents" intake (= today's production
//     behavior, NOT a regression introduced by this feature). Trigger:
//     production surfaces an uncovered service → expand the pattern list.
//   - Detection returns the FIRST matching service in pattern-order, NOT
//     the most-specific. Order of patterns matters: shorter / more-specific
//     anchors are listed first where collision is possible (e.g. Dropbox
//     short-URL `db.tt` before generic `dropbox.com`).

const FILE_HOSTING_PATTERNS = [
  // ─── Dropbox ─────────────────────────────────────────────────────
  // dropbox.com/s/{shareKey} — legacy share format (still issued).
  // dropbox.com/scl/{path} — current shared-content-link format
  // (per Dropbox help.dropbox.com docs).
  { service: 'Dropbox', pattern: /https?:\/\/(?:www\.)?dropbox\.com\/(?:s|scl)\/[A-Za-z0-9_\-\/?=&%.]+/i },
  // db.tt/{shortId} — Dropbox's official short-URL service.
  { service: 'Dropbox', pattern: /https?:\/\/db\.tt\/[A-Za-z0-9_\-]+/i },

  // ─── Google Drive ────────────────────────────────────────────────
  // drive.google.com/file/d/{ID}/... — file share
  // drive.google.com/drive/folders/{ID} — folder share
  // drive.google.com/open?id={ID} — legacy ?id= share
  // docs.google.com/{type}/d/{ID}/... — Workspace doc share (Docs/Sheets/Slides)
  // Google support docs.
  { service: 'Google Drive', pattern: /https?:\/\/(?:drive|docs)\.google\.com\/(?:file\/d\/|drive\/folders\/|open\?id=|(?:document|spreadsheets|presentation)\/d\/)[A-Za-z0-9_\-]+/i },

  // ─── OneDrive / SharePoint (Microsoft) ───────────────────────────
  // 1drv.ms/{shortPath} — official OneDrive share short-URL.
  { service: 'OneDrive', pattern: /https?:\/\/1drv\.ms\/[A-Za-z0-9_\-\/?=&%.]+/i },
  // onedrive.live.com — consumer OneDrive web share.
  { service: 'OneDrive', pattern: /https?:\/\/onedrive\.live\.com\/[A-Za-z0-9_\-\/?=&%.]+/i },
  // {tenant}.sharepoint.com/... — SharePoint tenant share (work/school OneDrive).
  { service: 'SharePoint', pattern: /https?:\/\/[A-Za-z0-9\-]+\.sharepoint\.com\/[A-Za-z0-9_\-\/?=&%.:]+/i },

  // ─── WeTransfer ──────────────────────────────────────────────────
  // wetransfer.com/downloads/{id}/... — WeTransfer share download page.
  { service: 'WeTransfer', pattern: /https?:\/\/(?:www\.)?wetransfer\.com\/downloads\/[A-Za-z0-9_\-]+/i },
  // we.tl/{shortId} — WeTransfer's official short-URL.
  { service: 'WeTransfer', pattern: /https?:\/\/we\.tl\/[A-Za-z0-9_\-]+/i },

  // ─── Box ─────────────────────────────────────────────────────────
  // (app.)box.com/s/{shareKey} — Box shared-link format.
  { service: 'Box', pattern: /https?:\/\/(?:app\.)?box\.com\/s\/[A-Za-z0-9_\-]+/i },

  // ─── iCloud Drive ────────────────────────────────────────────────
  // icloud.com/iclouddrive/#{shareKey} — Apple's iCloud Drive share URL.
  { service: 'iCloud Drive', pattern: /https?:\/\/(?:www\.)?icloud\.com\/iclouddrive\/[A-Za-z0-9_\-#]+/i },
];

const detectFileHostingLinksInBody = (emailBody) => {
  const noMatch = { hasLink: false, service: null, url: null };
  if (!emailBody || typeof emailBody !== 'string') return noMatch;
  // Sig-strip first: split on RFC sig delimiter `\n-- \n`, take the prefix.
  // Eliminates signature-block link false-positives.
  const sigDelim = emailBody.search(/\n--\s*\n/);
  const beforeFooter = sigDelim >= 0 ? emailBody.slice(0, sigDelim) : emailBody;
  for (const { service, pattern } of FILE_HOSTING_PATTERNS) {
    const m = beforeFooter.match(pattern);
    if (m) {
      return { hasLink: true, service, url: m[0] };
    }
  }
  return noMatch;
};

module.exports = {
  detectFileHostingLinksInBody,
  FILE_HOSTING_PATTERNS,  // exported for the LINK-DETECT test group
};
