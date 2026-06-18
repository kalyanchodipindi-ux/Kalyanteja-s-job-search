import { useState, useRef, useCallback } from 'react';

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const TABS = ['Analyze', 'Jobs', 'Tracker', 'Resume'];
const STATUS_OPTIONS = [
  'Applied',
  'Interview',
  'Shortlisted',
  'Offered',
  'Rejected',
];
const STATUS_COLORS = {
  Applied: 'bg-blue-600',
  Interview: 'bg-yellow-600',
  Shortlisted: 'bg-purple-600',
  Offered: 'bg-green-600',
  Rejected: 'bg-red-600',
};

// ── Robust JSON extractor ──────────────────────────────────────────────────────
function extractJSONArray(text) {
  // strip markdown fences
  text = text.replace(/```json|```/gi, '').trim();
  const start = text.indexOf('[');
  if (start === -1) throw new Error('No JSON array in response');
  // try full parse first
  try {
    return JSON.parse(text.slice(start));
  } catch (_) {}
  // recover complete objects from truncated response
  const objs = [];
  let depth = 0,
    inStr = false,
    esc = false,
    objStart = -1;
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === '\\' && inStr) {
      esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === '{') {
      if (!depth) objStart = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (!depth && objStart !== -1) {
        try {
          objs.push(JSON.parse(text.slice(objStart, i + 1)));
        } catch (_) {}
        objStart = -1;
      }
    }
  }
  if (objs.length) return objs;
  throw new Error('Could not parse jobs from response');
}

function extractJSON(text) {
  text = text.replace(/```json|```/gi, '').trim();
  const fi = text.indexOf('{'),
    li = text.lastIndexOf('}');
  const ai = text.indexOf('['),
    ali = text.lastIndexOf(']');
  if (ai !== -1 && (fi === -1 || ai < fi))
    return JSON.parse(text.slice(ai, ali + 1));
  if (fi !== -1) return JSON.parse(text.slice(fi, li + 1));
  throw new Error('No JSON found');
}

async function callClaude(messages, system, maxTokens = 2000) {
  const body = { model: CLAUDE_MODEL, max_tokens: maxTokens, messages };
  if (system) body.system = system;
  const res = await fetch('/api/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${res.status}`);
  }
  const data = await res.json();
  return data.content.map((b) => b.text || '').join('');
}

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(',')[1]);
    r.onerror = () => rej(new Error('File read failed'));
    r.readAsDataURL(file);
  });
}

function ScoreBadge({ score }) {
  const n = parseInt(score) || 0;
  const color =
    n >= 70
      ? 'bg-green-500'
      : n >= 50
      ? 'bg-yellow-500'
      : n >= 30
      ? 'bg-orange-500'
      : 'bg-red-500';
  return (
    <span
      className={`${color} text-white text-xs font-bold px-2 py-0.5 rounded-full`}
    >
      {n}%
    </span>
  );
}

function Spinner({ text }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10">
      <div className="w-9 h-9 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      <p className="text-indigo-300 text-sm text-center px-6">{text}</p>
    </div>
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState(0);
  const [resumeText, setResumeText] = useState('');
  const [resumeFile, setResumeFile] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [applied, setApplied] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadMsg, setLoadMsg] = useState('');
  const [error, setError] = useState('');
  const [apifyToken, setApifyToken] = useState('');
  const [apifySaved, setApifySaved] = useState(false);
  const [selectedSkills, setSelectedSkills] = useState({});
  const [generatedResume, setGeneratedResume] = useState('');
  const [editableResume, setEditableResume] = useState('');
  const [isEditingResume, setIsEditingResume] = useState(false);
  const [genLoading, setGenLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileRef = useRef();

  const err = (msg) => {
    setError(msg);
    setLoading(false);
  };

  // ── Analyze ────────────────────────────────────────────────────────────────
  const analyzeResume = useCallback(async () => {
    const hasFile = resumeFile;
    const hasText = resumeText.trim().length > 30;
    if (!hasFile && !hasText) {
      err(
        'Please upload a resume file or paste at least a few lines of resume text.'
      );
      return;
    }
    setError('');
    setLoading(true);
    setLoadMsg('Reading your resume…');
    try {
      let messages;
      if (hasFile && resumeFile.type === 'application/pdf') {
        const b64 = await fileToBase64(resumeFile);
        messages = [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: b64,
                },
              },
              { type: 'text', text: 'Analyze this resume. Return ONLY JSON.' },
            ],
          },
        ];
      } else if (hasFile) {
        const txt = await resumeFile.text();
        messages = [
          {
            role: 'user',
            content: `Analyze this resume:\n\n${txt}\n\nReturn ONLY JSON.`,
          },
        ];
      } else {
        messages = [
          {
            role: 'user',
            content: `Analyze this resume:\n\n${resumeText}\n\nReturn ONLY JSON.`,
          },
        ];
      }
      setLoadMsg('AI analyzing your profile…');
      const system = `You are an expert IT recruiter for the Indian job market.
Return ONLY valid JSON, no markdown, no extra text:
{"name":"","email":"","phone":"","experience_years":0,"experience_level":"Fresher|Junior|Mid|Senior|Lead","primary_skills":[""],"secondary_skills":[""],"domains":[""],"certifications":[""],"education":"","current_role":"","cobol_experience":"describe or None","target_roles":[""],"target_companies":[""],"resume_keywords":[""],"strengths":[""],"gaps":[""],"summary":"2-3 sentences"}`;
      const raw = await callClaude(messages, system, 1000);
      const parsed = extractJSON(raw);
      setAnalysis(parsed);
      setTab(1);
      // auto-search after analysis
      await doSearchJobs(parsed);
    } catch (e) {
      err('Analysis failed: ' + e.message);
    } finally {
      setLoading(false);
    }
  }, [resumeFile, resumeText]);

  // ── Search Jobs ────────────────────────────────────────────────────────────
  const doSearchJobs = useCallback(
    async (a) => {
      const profile = a || analysis;
      if (!profile) {
        err('Analyze resume first.');
        return;
      }
      setError('');
      setLoading(true);
      setLoadMsg('Finding matching jobs… (20-30s)');
      try {
        const skills = (profile.primary_skills || []).slice(0, 4).join(', ');
        const ctx = `Skills: ${skills}. Exp: ${profile.experience_years}yrs ${
          profile.experience_level
        }. COBOL: ${profile.cobol_experience || 'unknown'}.`;
        const system = `You are an IT job search AI for India. Return ONLY a valid JSON array of 8 job objects. No text before or after the array.
Each object must have ALL these fields:
{"title":"","company":"","location":"City, India","platform":"Naukri|LinkedIn|Indeed","apply_url":"https://naukri.com/job-listings","match_score":65,"key_skills":["COBOL","JCL"],"why_match":"One sentence","posted_days_ago":5,"experience_required":"3-5 years","salary_range":"12-18 LPA","missing_skills":["skill1"]}
Constraints: match_score between 10-95. Include range from low to high matches. Real company names (TCS,Infosys,Wipro,HCL,Accenture,Capgemini,LTIMindtree,IBM,Mphasis,Cognizant). Hyderabad preferred.`;
        const prompt = `Candidate: ${ctx}\nGenerate 8 COBOL-relevant IT job listings in India as a JSON array.`;
        const raw = await callClaude(
          [{ role: 'user', content: prompt }],
          system,
          2000
        );
        const arr = extractJSONArray(raw);
        setJobs(arr.sort((a, b) => b.match_score - a.match_score));
      } catch (e) {
        err('Job search failed: ' + e.message);
      } finally {
        setLoading(false);
      }
    },
    [analysis]
  );

  const searchJobs = () => doSearchJobs(null);

  // ── Mark Applied ────────────────────────────────────────────────────────────
  const markApplied = useCallback(
    (job) => {
      if (
        applied.find((a) => a.title === job.title && a.company === job.company)
      )
        return;
      const entry = {
        id: Date.now(),
        title: job.title,
        company: job.company,
        location: job.location,
        platform: job.platform,
        apply_url: job.apply_url,
        match_score: job.match_score,
        missing_skills: job.missing_skills || [],
        status: 'Applied',
        applied_date: new Date().toLocaleDateString('en-IN'),
        notes: '',
      };
      setApplied((p) => [entry, ...p]);
      setSelectedSkills((p) => ({ ...p, [entry.id]: [] }));
    },
    [applied]
  );

  // ── Generate Resume ─────────────────────────────────────────────────────────
  const generateResume = useCallback(
    async (job) => {
      const skills = selectedSkills[job.id] || [];
      if (!skills.length) {
        err('Select at least one skill to add.');
        return;
      }
      setGenLoading(true);
      setError('');
      try {
        const base =
          resumeText ||
          (analysis
            ? `Name: ${analysis.name}. Current Role: ${
                analysis.current_role
              }. Skills: ${(analysis.primary_skills || []).join(
                ', '
              )}. COBOL: ${analysis.cobol_experience}. Experience: ${
                analysis.experience_years
              } years. Education: ${analysis.education}.`
            : 'No base resume provided.');
        const prompt = `You are a professional resume writer for Indian IT market.

Base resume info:
${base}

Target job: ${job.title} at ${job.company}
Skills to add: ${skills.join(', ')}

Write a complete, ATS-optimized resume in plain text. Include:
1. Contact info section
2. Professional Summary (3 lines, targeting this role)
3. Technical Skills section (include COBOL prominently, add the new skills naturally)
4. Work Experience (use action verbs, quantify achievements)
5. Education
6. Certifications (if any)

Important: Write complete resume, not a template. Make it ready to submit.`;
        const result = await callClaude(
          [{ role: 'user', content: prompt }],
          '',
          1800
        );
        setGeneratedResume(result);
        setEditableResume(result);
        setIsEditingResume(false);
        setTab(3);
      } catch (e) {
        err('Resume generation failed: ' + e.message);
      } finally {
        setGenLoading(false);
      }
    },
    [selectedSkills, resumeText, analysis]
  );

  // ── Download ────────────────────────────────────────────────────────────────
  const downloadResume = () => {
    const content = isEditingResume ? editableResume : generatedResume;
    if (!content) return;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'my_resume.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const copyResume = async () => {
    const content = isEditingResume ? editableResume : generatedResume;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (_) {
      // fallback for mobile
      const el = document.createElement('textarea');
      el.value = content;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const toggleSkill = (jobId, skill) =>
    setSelectedSkills((p) => {
      const curr = p[jobId] || [];
      return {
        ...p,
        [jobId]: curr.includes(skill)
          ? curr.filter((s) => s !== skill)
          : [...curr, skill],
      };
    });

  const resumeDisplay = isEditingResume ? editableResume : generatedResume;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Header */}
      <div className="bg-gradient-to-r from-indigo-900 to-purple-900 px-4 py-3 flex items-center gap-3">
        <div className="w-9 h-9 bg-indigo-500 rounded-xl flex items-center justify-center font-black text-sm shrink-0">
          KJ
        </div>
        <div>
          <h1 className="text-base font-black text-white">
            Kalyan's <span className="text-indigo-300">Job Search</span>
          </h1>
          <p className="text-xs text-indigo-400">
            AI-Powered • COBOL Specialist • Hyderabad
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-slate-900 border-b border-slate-700 flex sticky top-0 z-20">
        {TABS.map((t, i) => (
          <button
            key={t}
            onClick={() => setTab(i)}
            className={`flex-1 py-3 text-xs font-semibold border-b-2 transition-colors relative ${
              tab === i
                ? 'border-indigo-400 text-indigo-300 bg-slate-800'
                : 'border-transparent text-slate-500'
            }`}
          >
            {t}
            {i === 1 && jobs.length > 0 && (
              <span className="absolute top-1 right-1 w-4 h-4 bg-indigo-600 rounded-full text-white text-xs flex items-center justify-center">
                {jobs.length}
              </span>
            )}
            {i === 2 && applied.length > 0 && (
              <span className="absolute top-1 right-1 w-4 h-4 bg-green-600 rounded-full text-white text-xs flex items-center justify-center">
                {applied.length}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="px-3 py-4 max-w-xl mx-auto pb-20">
        {/* Error */}
        {error && (
          <div className="mb-4 bg-red-900/70 border border-red-600 text-red-200 rounded-xl px-3 py-3 text-sm flex gap-2">
            <span className="flex-1 leading-snug">{error}</span>
            <button
              onClick={() => setError('')}
              className="text-red-400 font-bold shrink-0 text-base"
            >
              ✕
            </button>
          </div>
        )}

        {/* ── TAB 0: Analyze ── */}
        {tab === 0 && (
          <div className="space-y-4">
            {/* Apify */}
            <div className="bg-slate-800 border border-slate-700 rounded-2xl p-4">
              <p className="text-xs font-bold text-indigo-300 mb-1">
                🔑 Apify Token{' '}
                <span className="text-slate-500 font-normal">
                  (optional, for live jobs)
                </span>
              </p>
              <div className="flex gap-2 mt-2">
                <input
                  type="password"
                  value={apifyToken}
                  onChange={(e) => {
                    setApifyToken(e.target.value);
                    setApifySaved(false);
                  }}
                  placeholder="apify_api_xxxx…"
                  className="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 min-w-0"
                />
                <button
                  onClick={() => {
                    setApifySaved(true);
                    setTimeout(() => setApifySaved(false), 2500);
                  }}
                  className={`px-4 py-2.5 rounded-lg text-sm font-bold shrink-0 transition-colors ${
                    apifySaved
                      ? 'bg-green-600'
                      : 'bg-indigo-600 hover:bg-indigo-500'
                  }`}
                >
                  {apifySaved ? '✓' : 'Save'}
                </button>
              </div>
            </div>

            {/* Upload */}
            <div className="bg-slate-800 border border-slate-700 rounded-2xl p-4">
              <p className="text-xs font-bold text-indigo-300 mb-3">
                📄 Your Resume
              </p>
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.doc,.docx,.txt"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    setResumeFile(f);
                    setResumeText('');
                    setError('');
                  }
                }}
              />
              {/* Big upload button */}
              <button
                onClick={() => fileRef.current?.click()}
                className="w-full bg-indigo-700 hover:bg-indigo-600 active:bg-indigo-800 text-white font-bold py-4 rounded-xl text-sm transition-colors flex items-center justify-center gap-2"
              >
                <span className="text-xl">{resumeFile ? '✅' : '📁'}</span>
                <span>
                  {resumeFile
                    ? resumeFile.name
                    : 'Tap to Upload Resume (PDF/DOC/TXT)'}
                </span>
              </button>
              {resumeFile && (
                <button
                  onClick={() => setResumeFile(null)}
                  className="mt-2 w-full text-xs text-slate-400 hover:text-red-400 py-1"
                >
                  ✕ Remove file
                </button>
              )}

              <div className="flex items-center gap-2 my-3">
                <div className="flex-1 h-px bg-slate-700" />
                <span className="text-xs text-slate-500">or paste below</span>
                <div className="flex-1 h-px bg-slate-700" />
              </div>

              <textarea
                value={resumeText}
                onChange={(e) => {
                  setResumeText(e.target.value);
                  if (e.target.value) setResumeFile(null);
                }}
                placeholder="Paste your resume text here…&#10;&#10;(Name, skills, experience, education etc.)"
                rows={7}
                className="w-full bg-slate-700 border border-slate-600 rounded-xl px-3 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 resize-none leading-relaxed"
              />
              {resumeText.length > 0 && (
                <p className="text-xs text-slate-500 mt-1">
                  {resumeText.length} characters pasted
                </p>
              )}
            </div>

            {loading ? (
              <Spinner text={loadMsg} />
            ) : (
              <button
                onClick={analyzeResume}
                className="w-full bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-800 text-white font-bold py-4 rounded-xl text-base transition-colors"
              >
                🤖 Analyze & Find Jobs
              </button>
            )}

            {analysis && !loading && (
              <div className="bg-slate-800 border border-indigo-800 rounded-2xl p-4 space-y-3">
                <div>
                  <h3 className="font-black text-white">
                    {analysis.name || 'Profile Analyzed'}
                  </h3>
                  <p className="text-sm text-indigo-300">
                    {analysis.current_role} • {analysis.experience_years} yrs •{' '}
                    {analysis.experience_level}
                  </p>
                </div>
                <p className="text-sm text-slate-300 border-l-2 border-indigo-500 pl-3 leading-relaxed">
                  {analysis.summary}
                </p>
                <div className="bg-yellow-900/30 rounded-xl px-3 py-2">
                  <p className="text-xs text-yellow-400 font-bold mb-0.5">
                    COBOL Experience
                  </p>
                  <p className="text-sm text-yellow-200">
                    {analysis.cobol_experience || 'Not detected'}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-slate-400 uppercase font-semibold mb-1.5">
                    Primary Skills
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {(analysis.primary_skills || []).map((s) => (
                      <span
                        key={s}
                        className="bg-indigo-800 text-indigo-200 text-xs px-2 py-1 rounded-lg"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
                <button
                  onClick={() => setTab(1)}
                  className="w-full bg-green-600 hover:bg-green-500 text-white font-bold py-3 rounded-xl text-sm"
                >
                  View {jobs.length} Matched Jobs →
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── TAB 1: Jobs ── */}
        {tab === 1 && (
          <div className="space-y-3">
            <div className="flex gap-2 items-center">
              <h2 className="font-black text-white flex-1">
                {jobs.length ? `${jobs.length} Jobs` : 'Job Listings'}
              </h2>
              <button
                onClick={searchJobs}
                disabled={loading}
                className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold px-3 py-2 rounded-lg disabled:opacity-50"
              >
                🔄 Refresh
              </button>
            </div>

            {loading && <Spinner text={loadMsg} />}

            {!loading && !jobs.length && (
              <div className="text-center py-16">
                <div className="text-5xl mb-3">🔍</div>
                <p className="text-slate-400 font-semibold">No jobs yet.</p>
                <p className="text-slate-500 text-sm mt-1">
                  Go to Analyze tab and submit your resume.
                </p>
                <button
                  onClick={() => setTab(0)}
                  className="mt-4 text-indigo-400 underline text-sm"
                >
                  ← Go Analyze
                </button>
              </div>
            )}

            {!loading &&
              jobs.map((job, i) => {
                const isApplied = applied.some(
                  (a) => a.title === job.title && a.company === job.company
                );
                return (
                  <div
                    key={i}
                    className="bg-slate-800 border border-slate-700 rounded-2xl p-4"
                  >
                    <div className="flex gap-2 items-start mb-2">
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-white text-sm leading-tight">
                          {job.title}
                        </p>
                        <p className="text-indigo-300 text-sm">{job.company}</p>
                        <p className="text-slate-400 text-xs mt-0.5">
                          📍{job.location} • {job.posted_days_ago}d •{' '}
                          {job.experience_required}
                        </p>
                      </div>
                      <ScoreBadge score={job.match_score} />
                    </div>
                    <p className="text-slate-300 text-sm mb-2 leading-relaxed">
                      {job.why_match}
                    </p>
                    <div className="flex flex-wrap gap-1 mb-3">
                      {(job.key_skills || []).map((s) => (
                        <span
                          key={s}
                          className={`text-xs px-2 py-0.5 rounded ${
                            s.toLowerCase().includes('cobol')
                              ? 'bg-yellow-700 text-yellow-100 font-bold'
                              : 'bg-slate-700 text-slate-300'
                          }`}
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                    <div className="flex gap-2 items-center justify-between flex-wrap">
                      {job.salary_range && (
                        <span className="text-xs text-green-400 font-semibold">
                          {job.salary_range}
                        </span>
                      )}
                      <div className="flex gap-2 ml-auto">
                        <a
                          href={job.apply_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs bg-slate-700 text-slate-200 px-3 py-1.5 rounded-lg"
                        >
                          View ↗
                        </a>
                        <button
                          onClick={() => markApplied(job)}
                          disabled={isApplied}
                          className={`text-xs font-bold px-3 py-1.5 rounded-lg ${
                            isApplied
                              ? 'bg-green-800 text-green-300'
                              : 'bg-indigo-600 text-white'
                          }`}
                        >
                          {isApplied ? '✓ Applied' : '+ Track'}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>
        )}

        {/* ── TAB 2: Tracker ── */}
        {tab === 2 && (
          <div className="space-y-4">
            <h2 className="font-black text-white">
              Tracker{' '}
              <span className="text-slate-400 text-sm font-normal">
                ({applied.length})
              </span>
            </h2>
            {!applied.length && (
              <div className="text-center py-16">
                <div className="text-5xl mb-3">📋</div>
                <p className="text-slate-400 font-semibold">
                  No applications tracked.
                </p>
                <button
                  onClick={() => setTab(1)}
                  className="mt-4 text-indigo-400 underline text-sm"
                >
                  Go to Jobs →
                </button>
              </div>
            )}
            {applied.map((job) => (
              <div
                key={job.id}
                className="bg-slate-800 border border-slate-700 rounded-2xl p-4 space-y-3"
              >
                <div className="flex gap-2 items-start">
                  <div className="flex-1">
                    <p className="font-bold text-white text-sm">{job.title}</p>
                    <p className="text-indigo-300 text-sm">{job.company}</p>
                    <p className="text-slate-500 text-xs">
                      {job.applied_date} • {job.platform}
                    </p>
                  </div>
                  <ScoreBadge score={job.match_score} />
                </div>

                {/* Status buttons */}
                <div className="flex flex-wrap gap-1.5">
                  {STATUS_OPTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() =>
                        setApplied((p) =>
                          p.map((a) =>
                            a.id === job.id ? { ...a, status: s } : a
                          )
                        )
                      }
                      className={`text-xs px-2.5 py-1 rounded-lg font-medium border transition-colors ${
                        job.status === s
                          ? STATUS_COLORS[s] + ' text-white border-transparent'
                          : 'border-slate-600 text-slate-400'
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>

                {/* Missing skills */}
                {job.missing_skills?.length > 0 && (
                  <div className="bg-yellow-900/20 border border-yellow-800 rounded-xl p-3">
                    <p className="text-xs text-yellow-400 font-bold mb-2">
                      ⚡ Add to boost resume:
                    </p>
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {job.missing_skills.map((skill) => {
                        const sel = (selectedSkills[job.id] || []).includes(
                          skill
                        );
                        return (
                          <button
                            key={skill}
                            onClick={() => toggleSkill(job.id, skill)}
                            className={`text-xs px-2.5 py-1 rounded-lg border font-medium ${
                              sel
                                ? 'bg-yellow-600 border-yellow-500 text-white'
                                : 'border-yellow-700 text-yellow-400'
                            }`}
                          >
                            {sel ? '✓ ' : '+ '}
                            {skill}
                          </button>
                        );
                      })}
                    </div>
                    <button
                      onClick={() => generateResume(job)}
                      disabled={
                        !(selectedSkills[job.id] || []).length || genLoading
                      }
                      className="w-full bg-yellow-600 hover:bg-yellow-500 disabled:opacity-40 text-white text-xs font-bold py-2.5 rounded-lg"
                    >
                      {genLoading
                        ? 'Generating…'
                        : '✨ Generate Enhanced Resume'}
                    </button>
                  </div>
                )}

                <textarea
                  value={job.notes}
                  onChange={(e) =>
                    setApplied((p) =>
                      p.map((a) =>
                        a.id === job.id ? { ...a, notes: e.target.value } : a
                      )
                    )
                  }
                  placeholder="Notes: interview date, HR contact, feedback…"
                  rows={2}
                  className="w-full bg-slate-700 border border-slate-600 text-slate-300 text-xs rounded-lg px-3 py-2 resize-none focus:outline-none focus:border-indigo-500"
                />

                <div className="flex gap-2">
                  <a
                    href={job.apply_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 text-center text-xs bg-slate-700 text-slate-200 py-2 rounded-lg"
                  >
                    Open ↗
                  </a>
                  <button
                    onClick={() =>
                      setApplied((p) => p.filter((a) => a.id !== job.id))
                    }
                    className="text-xs text-red-400 px-3 py-2 rounded-lg"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── TAB 3: Resume ── */}
        {tab === 3 && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <h2 className="font-black text-white flex-1">
                ✨ Resume Builder
              </h2>
              {generatedResume && (
                <button
                  onClick={() => setIsEditingResume((e) => !e)}
                  className={`text-xs font-bold px-3 py-2 rounded-lg border transition-colors ${
                    isEditingResume
                      ? 'bg-indigo-600 text-white border-indigo-500'
                      : 'border-slate-600 text-slate-300'
                  }`}
                >
                  {isEditingResume ? '💾 Done' : '✏️ Edit'}
                </button>
              )}
            </div>

            {genLoading && <Spinner text="Writing your enhanced resume…" />}

            {!genLoading && !generatedResume && (
              <div className="text-center py-16">
                <div className="text-5xl mb-3">📝</div>
                <p className="text-slate-400 font-semibold">
                  No resume generated yet.
                </p>
                <p className="text-sm text-slate-500 mt-2 leading-relaxed px-4">
                  Go to <strong className="text-slate-300">Tracker</strong> →
                  pick a job → select missing skills → tap Generate.
                </p>
                <button
                  onClick={() => setTab(2)}
                  className="mt-4 bg-indigo-600 text-white text-sm font-bold px-5 py-2.5 rounded-xl"
                >
                  Go to Tracker →
                </button>
              </div>
            )}

            {!genLoading && generatedResume && (
              <>
                {/* Action buttons */}
                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={downloadResume}
                    className="bg-green-600 hover:bg-green-500 text-white text-xs font-bold py-3 rounded-xl flex flex-col items-center gap-1"
                  >
                    <span className="text-lg">⬇️</span>Download
                  </button>
                  <button
                    onClick={copyResume}
                    className={`text-xs font-bold py-3 rounded-xl flex flex-col items-center gap-1 transition-colors ${
                      copied
                        ? 'bg-green-700 text-white'
                        : 'bg-slate-700 hover:bg-slate-600 text-slate-200'
                    }`}
                  >
                    <span className="text-lg">{copied ? '✅' : '📋'}</span>
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                  <button
                    onClick={() => {
                      setGeneratedResume('');
                      setEditableResume('');
                      setIsEditingResume(false);
                    }}
                    className="bg-slate-800 border border-slate-600 text-slate-400 text-xs font-bold py-3 rounded-xl flex flex-col items-center gap-1"
                  >
                    <span className="text-lg">🗑️</span>Clear
                  </button>
                </div>

                {isEditingResume ? (
                  // Editable textarea
                  <div>
                    <p className="text-xs text-indigo-300 mb-2 font-semibold">
                      ✏️ Editing mode — tap Done when finished
                    </p>
                    <textarea
                      value={editableResume}
                      onChange={(e) => setEditableResume(e.target.value)}
                      className="w-full bg-slate-800 border border-indigo-500 text-slate-100 text-xs rounded-xl px-3 py-3 resize-none focus:outline-none font-mono leading-relaxed"
                      style={{ minHeight: '60vh' }}
                    />
                  </div>
                ) : (
                  // Read-only view
                  <div className="bg-slate-800 border border-slate-700 rounded-2xl p-4">
                    <p className="text-xs text-slate-400 mb-3 font-semibold uppercase">
                      Preview — tap ✏️ Edit to modify
                    </p>
                    <pre className="text-xs text-slate-200 whitespace-pre-wrap font-mono leading-relaxed overflow-x-auto">
                      {resumeDisplay}
                    </pre>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
