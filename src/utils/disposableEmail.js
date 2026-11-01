'use strict';

// Blocks throwaway inboxes when an account is created. The list is
// data/disposableEmailDomains.txt, a copy of
// github.com/disposable-email-domains/disposable-email-domains (one domain
// per line); replace the file to refresh it. It's kept in the repo so sign-up
// never depends on an outside service being up.

const fs = require('fs');
const path = require('path');
const { AppError } = require('../middleware/errorMiddleware');

const LIST_FILE = path.join(__dirname, '..', 'data', 'disposableEmailDomains.txt');
// Throwaway services the public list doesn't carry.
const EXTRA_DOMAINS = ['tempmail.com'];

let domains = null;
function loadDomains() {
  if (!domains) {
    const listed = fs.readFileSync(LIST_FILE, 'utf8').split(/\r?\n/).map((d) => d.trim().toLowerCase()).filter(Boolean);
    domains = new Set([...listed, ...EXTRA_DOMAINS]);
  }
  return domains;
}

// Also catches subdomains, so x.mailinator.com counts as mailinator.com.
function isDisposableEmail(email) {
  const domain = String(email || '').trim().toLowerCase().split('@').pop();
  const parts = domain.split('.');
  const list = loadDomains();
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (list.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

function assertPermanentEmail(email) {
  if (isDisposableEmail(email)) {
    throw new AppError("Temporary email addresses aren't allowed. Please use a permanent email address.", 400);
  }
}

module.exports = { isDisposableEmail, assertPermanentEmail };
