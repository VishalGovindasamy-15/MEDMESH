/**
 * Domain types.
 *
 * Narrowed by hand rather than generated from OpenAPI, and that is a deliberate
 * call: generated types make every optional server field optional in the UI,
 * which pushes defensive `?? 0` noise into every screen. These are the shapes
 * the app actually relies on, checked once at the boundary.
 */

export type Role =
  | 'citizen'
  | 'dispatcher'
  | 'driver'
  | 'hospital_admin'
  | 'gov_official'
  | 'platform_admin';

export type FreshnessState = 'live' | 'warm' | 'stale' | 'cold' | 'unknown';
export type TrustBand = 'high' | 'medium' | 'low';
export type Congestion = 'low' | 'moderate' | 'high' | 'critical';

export interface SessionUser {
  id: number;
  email: string;
  full_name: string;
  phone: string | null;
  role: Role;
  hospital_id: number | null;
  hospital_name: string | null;
  district_id: number | null;
  district_name: string | null;
  scope: string | null;
  /** True while the account is still on its administrator-issued first password. */
  must_change_password?: boolean;
  password_changed_at?: string | null;
  last_login_at: string | null;
}

/** A published pilot sign-in, served by `GET /auth/demo-accounts`. */
export interface DemoAccount {
  role: Role;
  label: string;
  email: string;
  password: string;
  surface: string;
  description: string;
}

export interface DemoAccountsPayload {
  demo_mode: boolean;
  environment: string;
  accounts: DemoAccount[];
  note: string;
}

export interface TrustFactor {
  label: string;
  detail: string;
  delta: string;
}

export interface TrustVerdict {
  score: number;
  band: TrustBand;
  factors: TrustFactor[];
  quarantined: boolean;
  flags: string[];
}

export interface Capacity {
  hospital_id: number;
  beds_available: number;
  total_beds: number;
  icu_available: number;
  total_icu: number;
  ventilators_available: number;
  total_ventilators: number;
  ed_congestion: Congestion;
  ed_waiting: number;
  blood_units: number;
  antivenom_vials: number;
  source: string;
  recorded_at: string;
  trust_state: string;
  anomaly_flags: string[];
  quarantined: boolean;
  holds_active: number;
  version: number;
  beds_effective: number;
  icu_effective: number;
  vent_effective: number;
}

export interface Facility {
  id: number;
  slug: string;
  name: string;
  short_name: string;
  type: 'public' | 'private' | 'trust';
  type_label: string;
  district_id: number;
  district_name?: string;
  address: string;
  lat: number;
  lng: number;
  phone: string;
  emergency_phone: string | null;
  verification: 'unverified' | 'pending' | 'verified' | 'suspended';
  integration: 'api' | 'manual';
  source_system: string | null;
  expose_doctor_directory: boolean;
  specialties: string[];
  capabilities: {
    blood_bank: boolean;
    trauma_centre: boolean;
    cath_lab: boolean;
    burn_unit: boolean;
    dialysis: boolean;
    neonatal_icu: boolean;
  };
  declared: { beds: number; icu: number; ventilators: number };
  capacity: Capacity | null;
  trust: TrustVerdict | null;
  holds?: Record<string, number>;
  /**
   * Clinician cover right now. Counts and specialty names only — no clinician is
   * identified on a listing. A facility that has opted out reports
   * `withheld: true` with zeroes rather than omitting the field, so a caller can
   * tell "nobody on duty" from "this was not sent".
   */
  doctors?: {
    available: boolean;
    on_duty: number;
    accepting_emergency: number;
    specialties: string[];
    withheld: boolean;
  };
}

export interface FacilityDetail extends Facility {
  history: {
    t: string;
    beds: number;
    icu: number;
    vent: number;
    ed_waiting: number;
    congestion: Congestion;
    source: string;
    quarantined: boolean;
  }[];
  doctors_on_duty: {
    id: number;
    full_name: string;
    specialty: string;
    designation: string;
    department: string;
    shift: string;
    accepts_emergency: boolean;
    duty_end: string | null;
    /** Effective availability: the window has not elapsed. */
    on_duty: boolean;
    roster_flag: boolean;
    duty_state: 'on_duty' | 'off_duty' | 'expired';
    minutes_remaining: number | null;
  }[];
  /**
   * Inbound cases holding capacity at this facility. Staff-scoped: the API
   * omits the key entirely for the public rather than sending an empty array,
   * so that "you are not cleared to see dispatch traffic" is distinguishable
   * from "nothing is coming". Read it as optional or the public facility page
   * dies on the first render.
   */
  active_holds?: {
    id: number;
    resource: string;
    expires_at: string;
    seconds_remaining: number;
    incident_id: number | null;
    /** Case reference, urgency, crew and live ETA — what the ward acts on. */
    reference: string | null;
    urgency: string | null;
    category: string | null;
    status: string | null;
    ambulance_call_sign: string | null;
    eta_minutes: number | null;
    distance_km: number | null;
  }[];
}

export interface Doctor {
  id: number;
  full_name: string;
  registration_no: string;
  specialty: string;
  specialty_label: string;
  department: string;
  designation: string;
  on_duty: boolean;
  duty_state: 'on_duty' | 'off_duty' | 'expired';
  shift: string;
  shift_window: string;
  duty_end: string | null;
  /** Signed: negative once the window has passed, so a caller can tell
   *  "ends in 4 minutes" from "ended 4 minutes ago". */
  minutes_remaining: number | null;
  /** The stored roster flag, before duty_end is taken into account. Only the
   *  roster screen needs the difference; everything else uses `on_duty`. */
  roster_flag?: boolean;
  accepts_emergency: boolean;
  languages: string[];
  hospital: {
    id: number;
    name: string;
    short_name: string;
    type: string;
    address: string;
    lat: number;
    lng: number;
    phone: string;
  } | null;
  district: { id: number; name: string } | null;
}

export interface ShortlistCandidate {
  hospital_id: number;
  name: string;
  short_name: string;
  type: string;
  district_id: number;
  address: string;
  lat: number;
  lng: number;
  phone: string;
  eligible: boolean;
  score: number;
  breakdown: Record<string, number>;
  reasons: string[];
  warnings: string[];
  blockers: string[];
  distance_km: number;
  eta_minutes: number;
  distance_label: string;
  /**
   * Where the distance and ETA came from. A dispatcher comparing two facilities
   * is entitled to know whether both numbers came off the road network or one
   * of them is straight-line geometry inflated by a winding factor -- the two
   * disagree most in hilly or river-cut terrain, which is exactly where the
   * choice is hardest.
   */
  distance_is_road: boolean;
  distance_provider: string;
  traffic_aware: boolean;
  straight_km: number;
  capacity: Capacity | null;
  freshness: { state: FreshnessState; label: string; age_seconds: number } | null;
  trust: TrustVerdict | null;
}

/**
 * How a shortlist's distances were resolved. Present on every ranked response
 * so the console can disclose it rather than leaving a dispatcher to assume.
 */
export interface RoutingSummary {
  total: number;
  routed: number;
  estimated: number;
  traffic_aware: number;
  road_derived: boolean;
  fully_routed: boolean;
  provider: string;
  prefilter_km: number;
  catchment_minutes: number;
}

export interface Incident {
  id: number;
  reference: string;
  category: string;
  category_label: string;
  urgency: 'P1' | 'P2' | 'P3';
  lat: number;
  lng: number;
  landmark: string;
  /** Supporting place detail: the coordinate leads, this confirms it. */
  taluk: string | null;
  district_id: number;
  district_name: string | null;
  /**
   * How the coordinate was obtained, and whether it can be trusted at face
   * value. `district` means the recorded point is the district centre, not the
   * caller's position -- the matching engine measured its drive times from
   * there, so any screen that shows an ETA has to say so alongside it.
   */
  location_source: 'gps' | 'map' | 'manual' | 'district';
  location_approximate: boolean;
  /** Structured scene assessment. No free-text clinical field exists. */
  scene: {
    patient_state: string;
    patient_state_label: string;
    mechanism: string;
    mechanism_label: string;
    bleeding: string;
    hazard: string;
    hazard_label: string;
    observations: string[];
    casualty_count: number;
    trapped: boolean;
    bystander_cpr: boolean;
  };
  /**
   * Resource requirements. `ambulance` is the capability preference order the
   * engine will use to pick a unit, best first — the same list the manual picker
   * ranks against, so choosing a crew by hand cannot disagree with the engine
   * about what this call needs.
   */
  requires: {
    icu: boolean;
    ventilator: boolean;
    blood: boolean;
    specialty: string | null;
    ambulance: string[];
    ambulance_labels: string[];
  };
  status: IncidentStatus;
  status_label: string;
  is_open: boolean;
  patient_aboard: boolean;
  created_at: string;
  /** One timestamp per stage of the trip, so "on scene" is distinguishable from
   *  "loaded" from "moving" without inferring any of them from the others. */
  dispatched_at: string | null;
  en_route_at: string | null;
  arrived_at: string | null;
  scene_arrived_at: string | null;
  patient_onboard_at: string | null;
  departed_scene_at: string | null;
  hospital_arrived_at: string | null;
  handed_over_at: string | null;
  /** Server-derived next moves for the crew, so the app and the API can never
   *  disagree about where the trip is. */
  next_actions?: { status: IncidentStatus; label: string; timestamp: string | null }[];
  elapsed_seconds: number;
  /** Ids as well as the expanded objects: comparing "is this my facility"
   *  should not require null-checking a nested object. */
  assigned_hospital_id: number | null;
  assigned_ambulance_id: number | null;
  /**
   * Facilities that have refused this patient, oldest first. A closed door is
   * remembered so a re-route does not re-offer it -- the dispatcher can still
   * override deliberately, with a reason.
   */
  declined_hospital_ids: number[];
  /** True when a facility has refused and no replacement has been chosen yet. */
  destination_withdrawn: boolean;
  facility_acknowledged_at?: string | null;
  facility_declined_at?: string | null;
  facility_decline_reason?: string | null;
  assigned_hospital: {
    id: number;
    name: string;
    short_name: string;
    phone: string;
    lat: number;
    lng: number;
    address: string;
  } | null;
  assigned_ambulance: {
    id: number;
    call_sign: string;
    operator: string;
    capability: string;
    capability_label: string;
    status: string;
    lat: number;
    lng: number;
  } | null;
  active_holds: { id: number; resource: string; expires_at: string; seconds_remaining: number }[];
  shortlist?: ShortlistCandidate[];
  match_snapshot?: { top: ShortlistCandidate[]; excluded: ShortlistCandidate[] };
}

export interface Ambulance {
  id: number;
  call_sign: string;
  registration: string;
  operator_type: string;
  operator_name: string;
  capability: string;
  capabilities?: string[];
  capability_label: string;
  capability_labels?: string[];
  status: string;
  status_label?: string;
  lat: number;
  lng: number;
  base_district_id?: number;
  base_district_name?: string | null;
  driver_user_id?: number | null;
  driver?: { id: number; full_name: string; email: string; phone: string | null } | null;
  crew_state?: 'linked' | 'unlinked';
  updated_at?: string | null;
}

/**
 * The ambulance trip lifecycle, in order.
 *
 * `arrived` is the deprecated spelling of `at_scene` and is never emitted. It
 * survives in this union so that a payload cached on a device before the upgrade
 * still type-checks; the server normalises it on the way in.
 */
export type IncidentStatus =
  | 'open'
  | 'dispatched'
  | 'en_route'
  | 'at_scene'
  | 'patient_onboard'
  | 'transporting'
  | 'at_hospital'
  | 'handed_over'
  | 'closed'
  | 'cancelled'
  | 'arrived';

/** The ordered spine, for progress indicators. */
export const TRIP_STAGES: IncidentStatus[] = [
  'dispatched',
  'en_route',
  'at_scene',
  'patient_onboard',
  'transporting',
  'at_hospital',
  'handed_over',
];

export const TRIP_TERMINAL: IncidentStatus[] = ['handed_over', 'closed', 'cancelled'];

export interface AmbulanceDriverLink {
  id: number;
  full_name: string;
  email: string;
  phone: string | null;
  district_id: number | null;
  district_name: string | null;
  linked_ambulance: { id: number; call_sign: string; status: string; base_district_id: number } | null;
}

export interface FleetDirectory {
  count: number;
  results: AmbulanceDriverLink[];
  crewless_units: Ambulance[];
  orphan_drivers: number;
}

export interface CrewAssignment {
  ambulance: Ambulance | null;
  assignment: (Incident & { scene_eta_minutes: number | null; scene_distance_km: number | null }) | null;
  destination: {
    id: number;
    name: string;
    short_name: string;
    address: string;
    phone: string;
    lat: number;
    lng: number;
    distance_km: number;
    eta_minutes: number;
    distance_label: string;
    bearing_deg: number;
    bearing_label: string;
    traffic_note: string;
    capabilities: Record<string, boolean>;
  } | null;
  destination_capacity: Capacity | null;
  route: {
    origin: { lat: number; lng: number };
    points: [number, number][];
    provider: string;
    generated_at: string;
  } | null;
  alternatives: ShortlistCandidate[];
  /** Present when there is nothing to show. `assignment` is null both when the
   *  crew is simply idle and when the account has no vehicle linked; `action_required`
   *  is what tells those apart, because only one of them resolves on its own. */
  message?: string;
  action_required?: string;
  /**
   * Receipt for the last completed handover, when there is no active trip.
   * A driver who refreshed the app after handing over used to land on a bare
   * "Standing by" and had no way to confirm the handover had actually been
   * recorded — the screen now shows the trip they just closed, its reference
   * and the receiving hospital.
   */
  last_trip?: {
    id: number;
    reference: string;
    status: string;
    status_label: string;
    handed_over_at: string | null;
    hospital_short_name: string | null;
  } | null;
}

export interface District {
  id: number;
  code: string;
  name: string;
  name_ta?: string | null;
  state: string;
  lat: number;
  lng: number;
  population: number;
  hospital_count?: number;
}

export interface DistrictRollup {
  district_id: number;
  district_name: string;
  population: number;
  hospitals: number;
  beds: { total: number; available: number; occupied: number; occupancy_pct: number | null };
  icu: { total: number; available: number; occupied: number; occupancy_pct: number | null };
  ventilators: { total: number; available: number; occupied: number; occupancy_pct: number | null };
  ed_congestion_index: number | null;
  reporting_facilities: number;
  stale_facilities: number;
}

export interface AnalyticsOverview {
  generated_at: string;
  state: {
    facilities: number;
    facilities_reporting: number;
    beds_total: number;
    beds_available: number;
    beds_occupancy_pct: number | null;
    icu_total: number;
    icu_available: number;
    icu_occupancy_pct: number | null;
  };
  operations: {
    incidents_last_24h: number;
    incidents_open: number;
    ambulances: number;
    ambulances_available: number;
    holds_active: number;
    open_feedback: number;
  };
  surge: {
    id: number;
    title: string;
    district_id: number;
    scope: string;
    opened_at: string;
    elapsed_minutes: number;
  } | null;
  districts: DistrictRollup[];
}

export interface DistrictDetail extends DistrictRollup {
  trend: {
    t: string;
    beds_available: number;
    icu_available: number;
    vent_available: number;
    ed_waiting: number;
    ed_congestion_index: number;
  }[];
  facilities: {
    id: number;
    name: string;
    short_name: string;
    type: string;
    verification: string;
    integration: string;
    total_beds: number;
    total_icu: number;
    beds_available: number | null;
    icu_available: number | null;
    vent_available: number | null;
    occupancy_pct: number | null;
    ed_congestion: Congestion | null;
    ed_waiting: number | null;
    holds: number;
    last_report_age_seconds: number | null;
  }[];
  open_incidents: {
    id: number;
    reference: string;
    category: string;
    urgency: string;
    status: string;
    landmark: string;
    created_at: string;
    age_minutes: number;
    hospital_id: number | null;
  }[];
  access: { role: string; drilldown_enabled: boolean };
}

export interface PlatformHealth {
  status: string;
  checked_at: string;
  facilities: { total: number; verified: number; projected: number };
  feed: { live: number; stale: number; coverage_pct: number };
  realtime: { clients: number };
  last_write_at: string | null;
  components: { name: string; state: string }[];
}

export interface FeedbackItem {
  id: number;
  hospital_id: number;
  hospital_name: string;
  kind: string;
  kind_label: string;
  comment: string;
  reporter_role: string;
  status: string;
  incident_id: number | null;
  created_at: string;
  age: string;
}

/* -- integration, inbox, provisioning -------------------------------------
 * Shapes for the surfaces that connect MedMesh to the systems hospitals
 * already run, and for the people who operate it.
 */

export type ConnectorKind = 'fhir_r4' | 'vendor_rest' | 'csv_sftp' | 'manual';
export type ConnectorHealth = 'healthy' | 'quiet' | 'failing' | 'never_seen' | 'disabled';

export interface Connector {
  id: number;
  hospital_id: number;
  hospital_name: string | null;
  hospital_short_name: string | null;
  kind: ConnectorKind;
  source_system: string | null;
  active: boolean;
  key_prefix: string | null;
  has_key: boolean;
  last_seen_at: string | null;
  last_seen_age_seconds: number | null;
  last_status_code: number | null;
  last_error: string | null;
  accepted_24h: number;
  rejected_24h: number;
  health: ConnectorHealth;
  created_at: string;
  rotated_at: string | null;
}

export interface ConnectorEstate {
  facilities: number;
  connectors: number;
  by_health: Record<string, number>;
  by_kind: Record<string, number>;
  by_integration: Record<string, number>;
  manual_facilities: number;
  api_without_connector: string[];
  ingest_url_fhir: string;
  ingest_url_vendor: string;
}

export interface ConnectorTemplate {
  kind: ConnectorKind;
  label: string;
  ingest_url: string | null;
  auth: string;
  description: string;
  fields?: string[];
  population_codes?: string[];
  sample: Record<string, unknown>;
}

export interface IssuedConnectorKey {
  connector_id: number;
  hospital_id: number;
  kind: ConnectorKind;
  key: string;
  key_shown_once: boolean;
  ingest_url: string | null;
  sample_payload: Record<string, unknown>;
  warning: string;
}

export interface ConnectorTestResult {
  ok: boolean;
  kind: string;
  message: string;
  parsed?: {
    beds_available: number;
    icu_available: number;
    ventilators_available: number;
    ed_congestion: string;
    ed_waiting: number;
    blood_units: number;
  };
  sample_payload?: Record<string, unknown>;
  ingest_url?: string;
}

export type NotificationKind =
  | 'inbound_patient'
  | 'hold_placed'
  | 'hold_expiring'
  | 'hold_released'
  | 'staleness_reminder'
  | 'submission_quarantined'
  | 'feedback_raised'
  | 'verification_decided'
  | 'surge_opened'
  | 'surge_closed'
  | 'connector_failing';

export interface NotificationItem {
  id: number;
  kind: NotificationKind;
  kind_label: string;
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'critical';
  hospital_id: number | null;
  hospital_name: string | null;
  incident_id: number | null;
  incident_reference: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
  age_seconds: number;
  read_at: string | null;
  acknowledged_by: number | null;
}

export interface InboxPage {
  count: number;
  unread: number;
  results: NotificationItem[];
}

export interface AdminUser {
  id: number;
  email: string;
  full_name: string;
  role: Role;
  is_active: boolean;
  hospital: string | null;
  district: string | null;
  vehicle: string | null;
  hospital_id: number | null;
  district_id: number | null;
  ambulance_id: number | null;
  last_login_at: string | null;
  created_at: string;
}

export interface OnboardingApplication {
  hospital_id: number;
  name: string;
  short_name: string;
  type: string;
  district: string | null;
  district_id: number | null;
  address: string;
  beds: number;
  icu: number;
  ventilators: number;
  verification: string;
  integration: string;
  specialties: string[];
  connector_kind: ConnectorKind | null;
  applied_at: string | null;
}

export interface OnboardingReceipt {
  hospital_id: number;
  reference: string;
  verification: string;
  message: string;
  next_steps: string[];
}

/* -- governance: audit, complaints, platform health ------------------------ */

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  role: string;
  action: string;
  entity: string;
  summary: string;
  payload: Record<string, unknown> | null;
  ip: string | null;
}

export interface Complaint {
  id: number;
  hospital_id: number;
  hospital_name: string;
  kind: string;
  kind_label: string;
  comment: string;
  reporter_role: string;
  status: string;
  incident_id: number | null;
  created_at: string;
  age: string;
}
