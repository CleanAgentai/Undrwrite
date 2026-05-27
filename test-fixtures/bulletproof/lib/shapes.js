// Franco-corpus placeholders + canonical Postmark shape templates for bulletproof
// fixture synthesis. Centralized so all scenarios draw from the same name/address/
// lender/financial corpus, preserving PII discipline across the matrix.

const VIENNA_INBOX = 'info@privatemortgagelink.com';

const BORROWERS = {
  marcus_webb: {
    fullName: 'Marcus Webb',
    legalName: 'Marcus Anthony Webb',
    email: 'marcus.webb@example.com',
    phone: '780-555-0142',
  },
  patricia_simmons: {
    fullName: 'Patricia Simmons',
    legalName: 'Patricia Anne Simmons',
    email: 'patricia.simmons@example.com',
    phone: '416-555-0188',
  },
  sarah_chen: {
    fullName: 'Sarah Chen',
    legalName: 'Sarah Mei-Ling Chen',
    email: 'sarah.chen@example.com',
    phone: '604-555-0211',
  },
  david_okafor: {
    fullName: 'David Okafor',
    legalName: 'David Chukwuemeka Okafor',
    email: 'david.okafor@example.com',
    phone: '905-555-0376',
  },
  jennifer_tran: {
    fullName: 'Jennifer Tran',
    email: 'jennifer.tran@example.com',
    phone: '780-555-0419',
  },
  webb_holdings_ltd: {
    fullName: 'Webb Holdings Ltd.',
    corporate: true,
    email: 'admin@webbholdings.example.com',
    phone: '780-555-0501',
  },
};

const BROKERS = {
  franco: {
    name: 'Franco Maione',
    email: 'fmaione@unionfinancialcorp.com',
    company: 'Union Financial Corp',
    licNumber: 'M19000158',
    signoff: 'Franco Maione\nLENDING & INVESTMENT SPECIALIST\n102, 10446 122 Street NW\nEdmonton, AB, T5N 1M3\nOFFICE.  780-244-4769\nCELL.  780-975-3339\nEMAIL.  fmaione@unionfinancialcorp.com',
  },
  jason_mercer: {
    name: 'Jason Mercer',
    email: 'jason@mercerbrokerage.example.com',
    company: 'Mercer Mortgage Group',
    licNumber: 'M12001505',
    signoff: 'Jason Mercer\nMercer Mortgage Group\nLic. #M12001505',
  },
  jonathan_ferrara: {
    name: 'Jonathan Ferrara',
    email: 'jferrara@ferrarafinancial.example.com',
    company: 'Ferrara Financial',
    licNumber: 'M16002271',
    signoff: 'Jonathan Ferrara\nFerrara Financial\nLic. #M16002271',
  },
};

const ADDRESSES = {
  edmonton_tory: {
    street: '1142 Tory Road NW',
    city: 'Edmonton',
    province: 'AB',
    postal: 'T6R 2K8',
    full: '1142 Tory Road NW, Edmonton, AB T6R 2K8',
  },
  toronto_glencairn: {
    street: '287 Glencairn Avenue',
    city: 'Toronto',
    province: 'ON',
    postal: 'M5N 1V3',
    full: '287 Glencairn Avenue, Toronto, ON M5N 1V3',
  },
  vancouver_kingsway: {
    street: '4421 Kingsway',
    city: 'Vancouver',
    province: 'BC',
    postal: 'V5R 5T7',
    full: '4421 Kingsway, Vancouver, BC V5R 5T7',
  },
  mississauga_winston: {
    street: '52 Winston Churchill Boulevard',
    city: 'Mississauga',
    province: 'ON',
    postal: 'L5M 4Y1',
    full: '52 Winston Churchill Boulevard, Mississauga, ON L5M 4Y1',
  },
  montreal_papineau: {
    street: '1855 Avenue Papineau',
    city: 'Montréal',
    province: 'QC',
    postal: 'H2K 4L7',
    full: '1855 Avenue Papineau, Montréal, QC H2K 4L7',
  },
  fredericton_riverside: {
    street: '218 Riverside Drive',
    city: 'Fredericton',
    province: 'NB',
    postal: 'E3B 5C2',
    full: '218 Riverside Drive, Fredericton, NB E3B 5C2',
  },
  stjohns_water: {
    street: '47 Water Street',
    city: "St. John's",
    province: 'NL',
    postal: 'A1C 1A4',
    full: "47 Water Street, St. John's, NL A1C 1A4",
  },
};

const LENDERS = {
  rbc: { name: 'Royal Bank of Canada', synonyms: ['RBC', 'Royal Bank', 'RBC Royal Bank'] },
  bmo: { name: 'Bank of Montreal', synonyms: ['BMO', 'B of M', 'Bank of Montreal'] },
  scotia: { name: 'Scotiabank', synonyms: ['Scotia', 'Scotiabank', 'Bank of Nova Scotia'] },
  td: { name: 'TD Canada Trust', synonyms: ['TD', 'TD Bank', 'TD Canada Trust', 'Toronto-Dominion'] },
  cibc: { name: 'CIBC', synonyms: ['CIBC', 'Canadian Imperial Bank of Commerce'] },
  national: { name: 'National Bank', synonyms: ['National Bank', 'National Bank of Canada'] },
  desjardins: { name: 'Desjardins', synonyms: ['Desjardins', 'Caisse Desjardins'] },
};

// Canonical Postmark inbound payload shape (matches what src/lib/postmark.js +
// src/routes/webhook.js parseInboundEmail consume). Used as the base template
// in emailSynth.buildPostmarkPayload.
const POSTMARK_SHAPE = {
  From: '',
  FromName: '',
  To: VIENNA_INBOX,
  Subject: '',
  TextBody: '',
  HtmlBody: null,
  MessageID: '',
  Date: '',
  Headers: [],
  Attachments: [],
};

module.exports = {
  VIENNA_INBOX,
  BORROWERS,
  BROKERS,
  ADDRESSES,
  LENDERS,
  POSTMARK_SHAPE,
};
