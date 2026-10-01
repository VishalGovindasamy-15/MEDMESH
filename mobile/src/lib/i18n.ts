/**
 * Interface language.
 *
 * Scope is deliberate. The report asks for a multilingual UI because a state-wide
 * rollout crosses first-language boundaries, and the audience that most needs it
 * is the public — someone standing at a roadside reading "ICU available" in
 * Tamil. So the citizen-facing surface is fully translated and the operational
 * consoles are not.
 *
 * That is a judgement, not an oversight. A 108 dispatcher works in English and
 * Tamil interchangeably on a console that is dense with clinical and
 * administrative vocabulary; a machine-translated "quarantined submission" or
 * "capability mismatch" would slow them down and could be misread. Operator
 * surfaces stay in English until they are professionally translated, which is
 * the only responsible way to translate a dispatch console.
 *
 * English is the source of truth. A missing key falls back to it rather than
 * showing a key or a blank, so a partial translation degrades quietly.
 */

export type Lang = 'en' | 'ta';

export const LANGUAGES: { value: Lang; label: string; native: string }[] = [
  { value: 'en', label: 'English', native: 'English' },
  { value: 'ta', label: 'Tamil', native: 'தமிழ்' },
];

type Dict = Record<string, string>;

const EN: Dict = {
  'app.tagline': 'CAPACITY EXCHANGE',
  'home.title': 'Where is care available right now',
  'home.search': 'Hospital, area or landmark',
  'home.searchHint': 'Name, district, specialty or capability — e.g. snakebite Pollachi',
  'home.voice': 'Speak your search',
  'home.voiceListening': 'Listening…',
  'home.voiceUnsupported': 'Voice search needs a browser with speech recognition',
  'home.facilities': '{n} facilities reporting',
  'home.reportingLive': 'Reporting live',
  'home.updatedNow': 'awaiting feed',
  'home.updatedAgo': 'feed updated {age}',
  'home.shown': '{shown} of {total} shown · tap a pin',
  'home.districts': 'All districts',
  'home.map': 'Coverage',
  'home.showMap': 'Show map',
  'home.hideMap': 'Hide map',
  'home.legend.icu': 'ICU free',
  'home.legend.beds': 'Beds only',
  'home.legend.full': 'At capacity',
  'home.legend.none': 'No live data',
  'home.disclaimer':
    'Capacity is self-reported by each facility and timestamped at the moment of report. MedMesh carries no patient records — only aggregate operational counts. Confirm by phone before committing a patient.',
  'filter.all': 'All',
  'filter.icu': 'ICU free',
  'filter.ventilator': 'Ventilator',
  'filter.trauma': 'Trauma',
  'filter.bloodBank': 'Blood bank',
  'filter.antivenom': 'Antivenom',
  'filter.public': 'Government',
  'filter.private': 'Private',
  'nav.directory': 'Directory',
  'nav.doctors': 'Doctors',
  'nav.dispatch': 'Dispatch',
  'nav.facility': 'My facility',
  'nav.crew': 'Crew',
  'nav.analytics': 'Analytics',
  'nav.inbox': 'Inbox',
  'nav.operations': 'Operations',
  'nav.signOut': 'Sign out',
  'common.beds': 'Beds',
  'common.icu': 'ICU',
  'common.ventilators': 'Ventilators',
  'common.waiting': 'Waiting',
  'common.available': 'available',
  'common.reportAt': 'Reported',
  'common.call': 'Call',
  'common.directions': 'Directions',
  'common.updated': 'Updated',
  'common.noData': 'No recent data',
  'common.minutesAgo': '{n} min ago',
  'common.hoursAgo': '{n} h ago',
  'common.language': 'Language',
  'facility.emergencyDesk': 'Emergency desk',
  'facility.doctorsOnDuty': 'Doctors on duty',
  'facility.noDoctors': 'No roster published',
};

/**
 * Tamil translations of the public surface.
 *
 * Everyday register, not formal literary Tamil: these strings are read under
 * stress by someone who may be reading slowly, and "உடனடி சிகிச்சைக்கு இடம்
 * உள்ளதா" is understood where a bureaucratic phrasing would not be.
 */
const TA: Dict = {
  'app.tagline': 'திறன் பரிமாற்றம்',
  'home.title': 'இப்போது எங்கே சிகிச்சை கிடைக்கும்',
  'home.search': 'மருத்துவமனை, பகுதி அல்லது அடையாளம்',
  'home.searchHint': 'பெயர் அல்லது பகுதி மூலம் தேடுங்கள்',
  'home.voice': 'பேசி தேடுங்கள்',
  'home.voiceListening': 'கேட்கிறது…',
  'home.voiceUnsupported': 'குரல் தேடலுக்கு உலாவி ஆதரவு தேவை',
  'home.facilities': '{n} மருத்துவமனைகள் தகவல் தருகின்றன',
  'home.reportingLive': 'நேரடி தகவல்',
  'home.updatedNow': 'தகவல் எதிர்பார்க்கப்படுகிறது',
  'home.updatedAgo': 'புதுப்பிப்பு {age}',
  'home.shown': '{total}-இல் {shown} காட்டப்படுகிறது · ஊசி முனையை தட்டுங்கள்',
  'home.districts': 'அனைத்து மாவட்டங்கள்',
  'home.map': 'பரப்பு',
  'home.showMap': 'வரைபடம் காட்டு',
  'home.hideMap': 'வரைபடம் மறை',
  'home.legend.icu': 'தீவிர சிகிச்சை இடம்',
  'home.legend.beds': 'படுக்கை மட்டும்',
  'home.legend.full': 'இடம் இல்லை',
  'home.legend.none': 'தற்போதைய தகவல் இல்லை',
  'home.disclaimer':
    'ஒவ்வொரு மருத்துவமனையும் தானே தெரிவிக்கும் தகவல் இது; தெரிவித்த நேரம் காட்டப்பட்டுள்ளது. MedMesh நோயாளர் விவரங்களை சேமிக்காது — மொத்த எண்ணிக்கை மட்டுமே. மருத்துவமனைக்கு செல்வதற்கு முன் தொலைபேசியில் உறுதிப்படுத்துங்கள்.',
  'filter.all': 'அனைத்தும்',
  'filter.icu': 'தீவிர சிகிச்சை',
  'filter.ventilator': 'வென்டிலேட்டர்',
  'filter.trauma': 'விபத்து சிகிச்சை',
  'filter.bloodBank': 'இரத்த வங்கி',
  'filter.antivenom': 'விஷ முறிவு மருந்து',
  'filter.public': 'அரசு',
  'filter.private': 'தனியார்',
  'nav.directory': 'பட்டியல்',
  'nav.doctors': 'மருத்துவர்கள்',
  'nav.dispatch': 'அனுப்புதல்',
  'nav.facility': 'என் மருத்துவமனை',
  'nav.crew': 'ஊழியர்',
  'nav.analytics': 'புள்ளிவிவரம்',
  'nav.inbox': 'அறிவிப்புகள்',
  'nav.operations': 'செயல்பாடு',
  'nav.signOut': 'வெளியேறு',
  'common.beds': 'படுக்கைகள்',
  'common.icu': 'தீவிர சிகிச்சை',
  'common.ventilators': 'வென்டிலேட்டர்',
  'common.waiting': 'காத்திருப்பு',
  'common.available': 'கிடைக்கும்',
  'common.reportAt': 'தெரிவித்த நேரம்',
  'common.call': 'அழைக்க',
  'common.directions': 'வழி',
  'common.updated': 'புதுப்பிப்பு',
  'common.noData': 'தற்போதைய தகவல் இல்லை',
  'common.minutesAgo': '{n} நிமிடம் முன்',
  'common.hoursAgo': '{n} மணி முன்',
  'common.language': 'மொழி',
  'facility.emergencyDesk': 'அவசர பிரிவு',
  'facility.doctorsOnDuty': 'பணியில் உள்ள மருத்துவர்கள்',
  'facility.noDoctors': 'மருத்துவர் பட்டியல் இல்லை',
};

const DICTS: Record<Lang, Dict> = { en: EN, ta: TA };

/**
 * Translate a key, substituting `{name}` placeholders.
 *
 * Falls back to English, then to the key itself — a visible key is a bug report,
 * whereas an empty string is a mystery.
 */
export function translate(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  const raw = DICTS[lang]?.[key] ?? EN[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name: string) =>
    vars[name] === undefined ? `{${name}}` : String(vars[name]),
  );
}

/** Whether any translation exists for a language, used to hide empty options. */
export function translatedKeys(lang: Lang): number {
  return Object.keys(DICTS[lang] ?? {}).length;
}
