import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BadgeCheck,
  Camera,
  CheckCircle2,
  Clock,
  CreditCard,
  LogIn,
  LogOut,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  UserRound,
  XCircle,
} from "lucide-react";
import jmTrainingLogo from "../assets/jm-training-logo.jpeg";
import "./MembershipCheckInApp.css";

const MEMBERS_STORAGE_KEY = "jmt-membership-members-v1";
const VISITS_STORAGE_KEY = "jmt-membership-visits-v1";
const API_STORAGE_KEY = "jmt-membership-api-url-v1";

const MEMBERSHIP_OPTIONS = [
  {
    id: "starter",
    label: "Starter",
    description: "Entry membership",
    accent: "#9f7a45",
  },
  {
    id: "pro",
    label: "Pro",
    description: "Regular range access",
    accent: "#c2934c",
  },
  {
    id: "university",
    label: "University",
    description: "Full access membership",
    accent: "#7b5036",
  },
];

const STATUS_OPTIONS = ["Active", "Past Due", "Paused", "Canceled"];

const MEMBERSHIP_ALIASES = {
  foundation: "starter",
  training: "pro",
  elite: "university",
};

function requestJsonp(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const callbackName = `jmtMembershipCallback_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    const url = new URL(endpoint);
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
    url.searchParams.set("callback", callbackName);

    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("Google Sheets load timed out. Check the Web App URL and deployment access."));
    }, 12000);

    function cleanup() {
      window.clearTimeout(timeoutId);
      script.remove();
      delete window[callbackName];
    }

    window[callbackName] = (data) => {
      cleanup();
      resolve(data);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("Google Sheets load failed. Re-deploy the Apps Script Web App and allow access to Anyone."));
    };

    script.src = url.toString();
    document.body.appendChild(script);
  });
}

function readStoredJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function todayInputValue() {
  return new Date().toISOString().slice(0, 10);
}

function formatDateTime(value) {
  if (!value) return "-";

  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function normalizeMember(rawMember = {}) {
  const cardId = String(rawMember.cardId || rawMember.CardID || rawMember.memberId || rawMember.MemberID || "")
    .trim()
    .toUpperCase();
  const memberId = String(rawMember.memberId || rawMember.MemberID || cardId || crypto.randomUUID()).trim();
  const rawMembership = String(rawMember.membership || rawMember.Membership || "starter").trim().toLowerCase();

  return {
    memberId,
    cardId: cardId || memberId.toUpperCase(),
    name: String(rawMember.name || rawMember.Name || "").trim(),
    email: String(rawMember.email || rawMember.Email || "").trim(),
    phone: String(rawMember.phone || rawMember.Phone || "").trim(),
    membership: MEMBERSHIP_ALIASES[rawMembership] || rawMembership || "starter",
    status: String(rawMember.status || rawMember.Status || "Active").trim() || "Active",
    joinDate: String(rawMember.joinDate || rawMember.JoinDate || todayInputValue()).slice(0, 10),
    notes: String(rawMember.notes || rawMember.Notes || "").trim(),
  };
}

function normalizeVisit(rawVisit = {}) {
  const rawMembership = String(rawVisit.membership || rawVisit.Membership || "").trim().toLowerCase();

  return {
    visitId: String(rawVisit.visitId || rawVisit.VisitID || crypto.randomUUID()).trim(),
    memberId: String(rawVisit.memberId || rawVisit.MemberID || "").trim(),
    cardId: String(rawVisit.cardId || rawVisit.CardID || "").trim().toUpperCase(),
    memberName: String(rawVisit.memberName || rawVisit.MemberName || rawVisit.name || "").trim(),
    membership: MEMBERSHIP_ALIASES[rawMembership] || rawMembership,
    status: String(rawVisit.status || rawVisit.Status || "").trim(),
    checkInAt: String(rawVisit.checkInAt || rawVisit.CheckInAt || "").trim(),
    checkOutAt: String(rawVisit.checkOutAt || rawVisit.CheckOutAt || "").trim(),
  };
}

function buildCardId(name) {
  const initials = String(name || "Member")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] || "")
    .join("")
    .toUpperCase();
  return `JMT-${initials || "MB"}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function membershipLabel(value) {
  const normalizedValue = MEMBERSHIP_ALIASES[String(value || "").trim().toLowerCase()] || String(value || "").trim().toLowerCase();
  return MEMBERSHIP_OPTIONS.find((option) => option.id === normalizedValue)?.label || value || "-";
}

function getQrUrl(cardId) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=12&data=${encodeURIComponent(cardId)}`;
}

function isMemberActive(member) {
  return String(member?.status || "").toLowerCase() === "active";
}

function makeBlankMember() {
  return {
    name: "",
    email: "",
    phone: "",
    membership: "starter",
    status: "Active",
    joinDate: todayInputValue(),
    notes: "",
  };
}

export default function MembershipCheckInApp() {
  const videoRef = useRef(null);
  const scanLoopRef = useRef(null);
  const streamRef = useRef(null);
  const apiFromEnv = String(import.meta.env.VITE_MEMBERSHIP_API_BASE || "").trim();
  const [apiUrl, setApiUrl] = useState(() => localStorage.getItem(API_STORAGE_KEY) || apiFromEnv);
  const [members, setMembers] = useState(() => {
    const savedMembers = readStoredJson(MEMBERS_STORAGE_KEY, null);
    if (Array.isArray(savedMembers) && savedMembers.length) {
      return savedMembers.map(normalizeMember);
    }

    return [
      normalizeMember({
        memberId: "sample-1",
        cardId: "JMT-DEMO-001",
        name: "Sample Member",
        email: "sample@example.com",
        phone: "555-0100",
        membership: "pro",
        status: "Active",
        joinDate: todayInputValue(),
      }),
    ];
  });
  const [visits, setVisits] = useState(() => {
    const savedVisits = readStoredJson(VISITS_STORAGE_KEY, []);
    return Array.isArray(savedVisits) ? savedVisits.map(normalizeVisit) : [];
  });
  const [form, setForm] = useState(makeBlankMember);
  const [search, setSearch] = useState("");
  const [scanInput, setScanInput] = useState("");
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [scannerActive, setScannerActive] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [syncStatus, setSyncStatus] = useState("Ready");
  const [busy, setBusy] = useState(false);

  const selectedMember = useMemo(
    () => members.find((member) => member.memberId === selectedMemberId) || members[0] || null,
    [members, selectedMemberId]
  );

  const activeVisits = useMemo(
    () => visits.filter((visit) => visit.checkInAt && !visit.checkOutAt),
    [visits]
  );

  const recentVisits = useMemo(
    () =>
      [...visits]
        .sort((a, b) => new Date(b.checkInAt || 0).getTime() - new Date(a.checkInAt || 0).getTime())
        .slice(0, 10),
    [visits]
  );

  const filteredMembers = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return members;

    return members.filter((member) =>
      [member.name, member.email, member.phone, member.cardId, membershipLabel(member.membership), member.status]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [members, search]);

  const stats = useMemo(() => {
    const activeCount = members.filter(isMemberActive).length;
    return {
      total: members.length,
      active: activeCount,
      checkedIn: activeVisits.length,
      pastDue: members.filter((member) => member.status === "Past Due").length,
    };
  }, [activeVisits.length, members]);

  useEffect(() => {
    localStorage.setItem(MEMBERS_STORAGE_KEY, JSON.stringify(members));
  }, [members]);

  useEffect(() => {
    localStorage.setItem(VISITS_STORAGE_KEY, JSON.stringify(visits));
  }, [visits]);

  useEffect(() => {
    localStorage.setItem(API_STORAGE_KEY, apiUrl);
  }, [apiUrl]);

  const callMembershipApi = useCallback(
    async (action, payload = {}) => {
      const endpoint = apiUrl.trim();
      if (!endpoint) {
        return null;
      }

      if (action === "membershipSnapshot") {
        const data = await requestJsonp(endpoint, { action });
        if (data?.ok === false) {
          throw new Error(data?.error || "Google Sheets load failed.");
        }
        return data;
      }

      const body = JSON.stringify({ action, payload });

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "text/plain;charset=utf-8",
          },
          body,
        });

        const data = await response.json();
        if (!response.ok || data?.ok === false) {
          throw new Error(data?.error || `Google Sheets request failed: ${response.status}`);
        }

        return data;
      } catch (error) {
        await fetch(endpoint, {
          method: "POST",
          mode: "no-cors",
          headers: {
            "Content-Type": "text/plain;charset=utf-8",
          },
          body,
        });

        return {
          ok: true,
          writeOnly: true,
          warning: error?.message || "Write sent without a readable Google response.",
        };
      }
    },
    [apiUrl]
  );

  const loadSnapshot = useCallback(async () => {
    if (!apiUrl.trim()) {
      setSyncStatus("Using local storage until you add the Google Apps Script URL.");
      return;
    }

    setBusy(true);
    setSyncStatus("Loading from Google Sheets...");
    try {
      const response = await callMembershipApi("membershipSnapshot");
      const nextMembers = Array.isArray(response?.members) ? response.members.map(normalizeMember) : [];
      const nextVisits = Array.isArray(response?.visits) ? response.visits.map(normalizeVisit) : [];

      if (nextMembers.length) {
        setMembers(nextMembers);
      }
      setVisits(nextVisits);
      setSyncStatus(`Synced ${nextMembers.length || members.length} members from Google Sheets.`);
    } catch (error) {
      setSyncStatus(error?.message || "Could not load Google Sheets data.");
    } finally {
      setBusy(false);
    }
  }, [apiUrl, callMembershipApi, members.length]);

  useEffect(() => {
    loadSnapshot();
  }, [loadSnapshot]);

  useEffect(() => {
    return () => {
      window.cancelAnimationFrame(scanLoopRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function saveMember(event) {
    event.preventDefault();
    const member = normalizeMember({
      ...form,
      memberId: crypto.randomUUID(),
      cardId: buildCardId(form.name),
    });

    if (!member.name) {
      setSyncStatus("Add a member name before saving.");
      return;
    }

    setBusy(true);
    const nextMembers = [member, ...members];
    setMembers(nextMembers);
    setSelectedMemberId(member.memberId);
    setForm(makeBlankMember());
    setSyncStatus("Member saved locally.");

    try {
      await callMembershipApi("upsertMember", member);
      setSyncStatus(`${member.name} saved to Google Sheets.`);
    } catch (error) {
      setSyncStatus(error?.message || "Member saved locally, but Google Sheets did not update.");
    } finally {
      setBusy(false);
    }
  }

  async function handleScan(rawCode) {
    const code = String(rawCode || "").trim().toUpperCase();
    if (!code) return;

    const member = members.find(
      (entry) => entry.cardId.toUpperCase() === code || entry.memberId.toUpperCase() === code
    );

    if (!member) {
      setSyncStatus(`No member found for ${code}.`);
      return;
    }

    setSelectedMemberId(member.memberId);

    if (!isMemberActive(member)) {
      setSyncStatus(`${member.name} is ${member.status}. Check their account before training.`);
      return;
    }

    const openVisit = visits.find((visit) => visit.memberId === member.memberId && !visit.checkOutAt);
    const now = new Date().toISOString();
    const nextVisit = openVisit
      ? { ...openVisit, checkOutAt: now }
      : normalizeVisit({
          visitId: crypto.randomUUID(),
          memberId: member.memberId,
          cardId: member.cardId,
          memberName: member.name,
          membership: member.membership,
          status: member.status,
          checkInAt: now,
          checkOutAt: "",
        });

    const nextVisits = openVisit
      ? visits.map((visit) => (visit.visitId === openVisit.visitId ? nextVisit : visit))
      : [nextVisit, ...visits];

    setVisits(nextVisits);
    setScanInput("");
    setSyncStatus(openVisit ? `${member.name} checked out.` : `${member.name} checked in.`);

    try {
      await callMembershipApi(openVisit ? "checkOutMember" : "checkInMember", nextVisit);
      setSyncStatus(openVisit ? `${member.name} checked out and synced.` : `${member.name} checked in and synced.`);
    } catch (error) {
      setSyncStatus(error?.message || "Attendance saved locally, but Google Sheets did not update.");
    }
  }

  async function startScanner() {
    if (!("BarcodeDetector" in window)) {
      setSyncStatus("Camera QR scanning is not supported in this browser. Use the scan box instead.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      streamRef.current = stream;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setScannerActive(true);
      setSyncStatus("Camera scanner is running.");

      const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      const tick = async () => {
        if (!videoRef.current || videoRef.current.readyState < 2) {
          scanLoopRef.current = window.requestAnimationFrame(tick);
          return;
        }

        try {
          const codes = await detector.detect(videoRef.current);
          if (codes[0]?.rawValue) {
            stopScanner();
            await handleScan(codes[0].rawValue);
            return;
          }
        } catch {
          setSyncStatus("Point the camera at the member QR code.");
        }

        scanLoopRef.current = window.requestAnimationFrame(tick);
      };

      scanLoopRef.current = window.requestAnimationFrame(tick);
    } catch (error) {
      setSyncStatus(error?.message || "Could not start the camera scanner.");
    }
  }

  function stopScanner() {
    window.cancelAnimationFrame(scanLoopRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setScannerActive(false);
  }

  function printCards() {
    window.print();
  }

  return (
    <main className="membership-app">
      <section className="membership-header">
        <div>
          <div className="membership-kicker">JM Training</div>
          <h1>Member Check-In</h1>
          <p>Scan a card, check membership status, and sync attendance to Google Sheets.</p>
        </div>
        <div className="membership-actions no-print">
          <button type="button" onClick={loadSnapshot} disabled={busy}>
            <RefreshCw size={18} />
            Sync
          </button>
          <button type="button" onClick={() => setSettingsOpen((value) => !value)}>
            <Settings size={18} />
            Sheets
          </button>
          <button type="button" onClick={printCards}>
            <Printer size={18} />
            Cards
          </button>
        </div>
      </section>

      {settingsOpen ? (
        <section className="membership-panel no-print">
          <label>
            Google Apps Script Web App URL
            <input
              value={apiUrl}
              onChange={(event) => setApiUrl(event.target.value)}
              placeholder="https://script.google.com/macros/s/.../exec"
            />
          </label>
          <p className="membership-muted">
            Deploy the script in docs/member-checkin-apps-script.gs, paste the Web App URL here, then press Sync.
          </p>
        </section>
      ) : null}

      <section className="membership-stats no-print">
        <div>
          <UsersIcon />
          <span>{stats.total}</span>
          <small>Total Members</small>
        </div>
        <div>
          <ShieldCheck size={22} />
          <span>{stats.active}</span>
          <small>Active</small>
        </div>
        <div>
          <LogIn size={22} />
          <span>{stats.checkedIn}</span>
          <small>Checked In</small>
        </div>
        <div>
          <XCircle size={22} />
          <span>{stats.pastDue}</span>
          <small>Past Due</small>
        </div>
      </section>

      <section className="membership-grid">
        <div className="membership-panel scanner no-print">
          <div className="panel-title">
            <Camera size={20} />
            Scanner
          </div>
          <video ref={videoRef} className={scannerActive ? "scanner-video active" : "scanner-video"} muted playsInline />
          <div className="scanner-controls">
            <button type="button" onClick={scannerActive ? stopScanner : startScanner}>
              <Camera size={18} />
              {scannerActive ? "Stop Camera" : "Scan QR"}
            </button>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                handleScan(scanInput);
              }}
            >
              <input
                value={scanInput}
                onChange={(event) => setScanInput(event.target.value)}
                placeholder="Scan or type card ID"
              />
              <button type="submit">
                <CheckCircle2 size={18} />
              </button>
            </form>
          </div>
          <div className="sync-status">{syncStatus}</div>
        </div>

        <div className="membership-panel no-print">
          <div className="panel-title">
            <Plus size={20} />
            New Member
          </div>
          <form className="member-form" onSubmit={saveMember}>
            <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Full name" />
            <input value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="Email" type="email" />
            <input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} placeholder="Phone" />
            <select value={form.membership} onChange={(event) => setForm({ ...form, membership: event.target.value })}>
              {MEMBERSHIP_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>
              {STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
            <input value={form.joinDate} onChange={(event) => setForm({ ...form, joinDate: event.target.value })} type="date" />
            <textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="Notes" />
            <button type="submit" disabled={busy}>
              <Plus size={18} />
              Add Member
            </button>
          </form>
        </div>

        <div className="membership-panel selected-card">
          <div className="panel-title">
            <CreditCard size={20} />
            Member Card
          </div>
          {selectedMember ? (
            <MemberCard member={selectedMember} />
          ) : (
            <div className="empty-card">Add a member to generate a card.</div>
          )}
        </div>
      </section>

      <section className="membership-lists no-print">
        <div className="membership-panel">
          <div className="list-header">
            <div className="panel-title">
              <UserRound size={20} />
              Members
            </div>
            <label className="search-box">
              <Search size={17} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search members" />
            </label>
          </div>
          <div className="member-list">
            {filteredMembers.map((member) => {
              const checkedIn = activeVisits.some((visit) => visit.memberId === member.memberId);
              return (
                <button
                  type="button"
                  key={member.memberId}
                  className={member.memberId === selectedMember?.memberId ? "member-row selected" : "member-row"}
                  onClick={() => setSelectedMemberId(member.memberId)}
                >
                  <span>
                    <strong>{member.name}</strong>
                    <small>{member.cardId} · {membershipLabel(member.membership)}</small>
                  </span>
                  <em className={checkedIn ? "checked-in" : ""}>{checkedIn ? "In" : member.status}</em>
                </button>
              );
            })}
          </div>
        </div>

        <div className="membership-panel">
          <div className="panel-title">
            <Clock size={20} />
            Recent Attendance
          </div>
          <div className="visit-list">
            {recentVisits.map((visit) => (
              <div key={visit.visitId} className="visit-row">
                <span>
                  <strong>{visit.memberName || visit.cardId}</strong>
                  <small>{membershipLabel(visit.membership)} · {visit.status || "Active"}</small>
                </span>
                <span>
                  <small>In {formatDateTime(visit.checkInAt)}</small>
                  <small>Out {formatDateTime(visit.checkOutAt)}</small>
                </span>
              </div>
            ))}
            {!recentVisits.length ? <div className="empty-card">No check-ins yet.</div> : null}
          </div>
        </div>
      </section>

      <section className="print-card-grid">
        {members.map((member) => (
          <MemberCard key={member.memberId} member={member} />
        ))}
      </section>
    </main>
  );
}

function UsersIcon() {
  return <UserRound size={22} />;
}

function MemberCard({ member }) {
  const normalizedMembership =
    MEMBERSHIP_ALIASES[String(member.membership || "").trim().toLowerCase()] ||
    String(member.membership || "").trim().toLowerCase();
  const option = MEMBERSHIP_OPTIONS.find((entry) => entry.id === normalizedMembership) || MEMBERSHIP_OPTIONS[0];

  return (
    <article className="member-card" style={{ "--tier-color": option.accent }}>
      <img className="card-logo-watermark" src={jmTrainingLogo} alt="" aria-hidden="true" />
      <div className="card-band">
        <span>JM Training</span>
        <BadgeCheck size={20} />
      </div>
      <div className="card-body">
        <div>
          <h2>{member.name || "Member"}</h2>
          <p>{membershipLabel(member.membership)} Membership</p>
          <dl>
            <div>
              <dt>Status</dt>
              <dd>{member.status}</dd>
            </div>
            <div>
              <dt>Join Date</dt>
              <dd>{member.joinDate || "-"}</dd>
            </div>
            <div>
              <dt>Card ID</dt>
              <dd>{member.cardId}</dd>
            </div>
          </dl>
        </div>
        <img className="card-qr" src={getQrUrl(member.cardId)} alt={`${member.name} QR code`} />
      </div>
    </article>
  );
}
