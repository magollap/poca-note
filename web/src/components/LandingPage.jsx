import {
  ArrowRight,
  BarChart3,
  Bot,
  CalendarClock,
  Check,
  CheckCircle2,
  Cpu,
  Hash,
  History,
  Keyboard,
  LayoutGrid,
  ListChecks,
  Lock,
  Moon,
  Palette,
  Play,
  Sparkles,
  Wand2,
  Zap,
} from "lucide-react";

const FEATURES = [
  {
    icon: Keyboard,
    tone: "gold",
    title: "Keyboard-first board",
    body: "Move cards, open editors, and clear your queue without touching the mouse. Every action has a key.",
  },
  {
    icon: ListChecks,
    tone: "green",
    title: "Numbers that mean something",
    body: "Every card and subtask carries a YYMM number like 261000001, so “Task 261000001” is unambiguous everywhere.",
  },
  {
    icon: Wand2,
    tone: "orange",
    title: "AI actions on the board",
    body: "Ask for a change in plain language, review the plan, then apply it. Task numbers keep the AI honest.",
  },
  {
    icon: BarChart3,
    tone: "green",
    title: "Reports that write themselves",
    body: "Daily, weekly, and monthly reviews built from real board activity — no spreadsheet archaeology.",
  },
  {
    icon: CalendarClock,
    tone: "gold",
    title: "Schedules that stay quiet",
    body: "Calm by design. Reports wait in the workspace until you are ready to read them.",
  },
  {
    icon: Lock,
    tone: "orange",
    title: "Tenant-scoped by default",
    body: "Each workspace has its own logins, boards, AI runs, and history. Observers stay read-only.",
  },
  {
    icon: Cpu,
    tone: "green",
    title: "Local-first and offline-ready",
    body: "The board caches locally and keeps working when the network drops, then syncs back when it returns.",
  },
];

const STEPS = [
  {
    step: "01",
    tone: "green",
    title: "Capture the work",
    body: "Type a title. poca-note assigns the next YYMM task number automatically and keeps the board sorted.",
  },
  {
    step: "02",
    tone: "gold",
    title: "Point at a number",
    body: "Open AI Actions, pick a task chip, and describe the change. The plan references real task numbers.",
  },
  {
    step: "03",
    tone: "orange",
    title: "Review, then apply",
    body: "Nothing moves until you press Apply. Every action is re-checked against the live board first.",
  },
];

const CARDS = [
  { no: "261000004", title: "Draft launch note", tone: "todo", tag: "Writing", steps: "2/4" },
  { no: "261000005", title: "Review pricing", tone: "doing", tag: "Finance", steps: "1/3" },
  { no: "261000006", title: "Ship the beta", tone: "done", tag: "Release", steps: "4/4" },
];

function Brand({ onClick }) {
  return (
    <a
      className="landing-brand"
      href="/"
      onClick={(event) => {
        if (!onClick) return;
        event.preventDefault();
        onClick("/");
      }}
      aria-label="poca-note home"
    >
      <span className="brand-mark" aria-hidden="true">
        <LayoutGrid size={18} strokeWidth={2.2} />
      </span>
      <span>
        poca<em>·</em>note
      </span>
    </a>
  );
}

export default function LandingPage({ navigate, signedIn = false }) {
  const go = (path) => navigate?.(path);

  return (
    <div className="landing">
      <header className="landing-nav">
        <div className="landing-nav-inner">
          <Brand onClick={go} />
          <nav className="landing-links" aria-label="Landing sections">
            <a href="#numbers">Numbers</a>
            <a href="#features">Features</a>
            <a href="#workflow">Workflow</a>
            <a href="#ai-actions">AI actions</a>
          </nav>
          <div className="landing-nav-actions">
            {signedIn ? (
              <button className="btn btn-primary btn-sm" type="button" onClick={() => go("/board")}>
                Open board <ArrowRight size={13} />
              </button>
            ) : (
              <>
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => go("/login")}>
                  Sign in
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  type="button"
                  onClick={() => go("/login?mode=create")}
                >
                  Start free <ArrowRight size={13} />
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <main>
        <section className="landing-hero">
          <div className="landing-hero-glow" aria-hidden="true" />
          <div className="landing-hero-inner">
            <div className="landing-hero-copy">
              <span className="landing-eyebrow">
                <Sparkles size={13} /> Keyboard-first · AI-native
              </span>
              <h1>
                Your tasks, <span className="landing-gradient-text">numbered</span>.
                <br />
                Your AI, <span className="landing-gradient-text">ready</span>.
              </h1>
              <p>
                poca-note is a personal Kanban where every card and subtask has a memorable YYMM
                number. Point your AI at a number, review the plan, and keep moving.
              </p>
              <div className="landing-hero-actions">
                <button
                  className="btn btn-primary landing-cta"
                  type="button"
                  onClick={() => go(signedIn ? "/board" : "/login?mode=create")}
                >
                  {signedIn ? "Open your board" : "Create your workspace"} <ArrowRight size={15} />
                </button>
                <a className="btn btn-ghost landing-cta" href="#ai-actions">
                  <Play size={14} /> See AI actions
                </a>
              </div>
              <ul className="landing-trust">
                <li>
                  <Check size={13} /> No credit card
                </li>
                <li>
                  <Check size={13} /> Tenant-scoped
                </li>
                <li>
                  <Check size={13} /> Works offline
                </li>
              </ul>
            </div>

            <div className="landing-hero-art" aria-hidden="true">
              <div className="landing-art-card art-top">
                <span className="art-dot green" />
                <div>
                  <b>Task 261000005</b>
                  <span>Review pricing</span>
                </div>
                <span className="art-pill">Doing</span>
              </div>

              <div className="landing-board-mock">
                <div className="mock-head">
                  <span className="mock-brand">
                    <LayoutGrid size={13} /> My board
                  </span>
                  <span className="mock-rev">revision 48</span>
                </div>
                <div className="mock-columns">
                  {["To Do", "Doing", "Done"].map((label, columnIndex) => (
                    <div className="mock-column" key={label}>
                      <div className="mock-column-head">
                        <span className={`mock-dot ${["todo", "doing", "done"][columnIndex]}`} />
                        {label}
                      </div>
                      {CARDS.filter((_, index) => index % 3 === columnIndex || index === 2).map((card) => (
                        <div className={`mock-card ${card.tone}`} key={card.no}>
                          <span className="mock-task-no">{card.no}</span>
                          <b>{card.title}</b>
                          <span className="mock-card-meta">
                            <span>{card.tag}</span>
                            <span>{card.steps} steps</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>

              <div className="landing-art-card art-ai">
                <span className="ai-art-icon">
                  <Wand2 size={14} />
                </span>
                <div>
                  <b>Mark Task 261000005 as done</b>
                  <span>
                    <CheckCircle2 size={11} /> Plan ready · 1 action
                  </span>
                </div>
              </div>

              <div className="landing-art-card art-report">
                <BarChart3 size={14} />
                <div>
                  <b>Weekly report</b>
                  <span>14 completed · 6 created</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="landing-stats" aria-label="poca-note at a glance">
          {[
            ["9-digit", "task numbers, easy to say out loud"],
            ["⌘↵", "plan and apply with the keyboard"],
            ["3", "boards, columns, and report rhythms"],
            ["100%", "tenant-scoped history and AI runs"],
          ].map(([value, label]) => (
            <div className="landing-stat" key={label}>
              <strong>{value}</strong>
              <span>{label}</span>
            </div>
          ))}
        </section>

        <section className="landing-anatomy" id="numbers">
          <div className="landing-anatomy-copy">
            <span className="landing-kicker tone-gold">
              <Hash size={13} /> Task numbers
            </span>
            <h2>One number. Zero ambiguity.</h2>
            <p>
              Every card and subtask gets a YYMM number. The first four digits say when it was
              created; the last five keep it unique. Say it out loud, type it into AI Actions, or
              search for it — the board knows exactly what you mean.
            </p>
            <ul className="landing-checklist">
              <li>
                <CheckCircle2 size={14} /> Cards and subtasks share one monthly series
              </li>
              <li>
                <CheckCircle2 size={14} /> Numbers never repeat inside a workspace
              </li>
              <li>
                <CheckCircle2 size={14} /> AI Actions accepts “Task 261000001”, “#261000001”, or the
                bare number
              </li>
            </ul>
          </div>
          <div className="landing-anatomy-art" aria-hidden="true">
            <div className="anatomy-number">
              <span className="anatomy-part tone-green">
                <b>26</b>
                <em>year</em>
              </span>
              <span className="anatomy-part tone-gold">
                <b>10</b>
                <em>month</em>
              </span>
              <span className="anatomy-part tone-orange">
                <b>00001</b>
                <em>sequence</em>
              </span>
            </div>
            <div className="anatomy-equals">
              = <b>261000001</b>
            </div>
            <div className="anatomy-examples">
              <div className="anatomy-example">
                <b>261000001</b>
                <span>Ship the beta</span>
                <i>To Do</i>
              </div>
              <div className="anatomy-example">
                <b>261000002</b>
                <span>Check margins</span>
                <i>subtask</i>
              </div>
              <div className="anatomy-example">
                <b>261000003</b>
                <span>Review pricing</span>
                <i>Doing</i>
              </div>
            </div>
          </div>
        </section>

        <section className="landing-section" id="features">
          <div className="landing-section-head">
            <span className="landing-kicker">
              <Zap size={13} /> Built for focus
            </span>
            <h2>Everything you need, nothing you have to babysit.</h2>
            <p>
              A calm board with loud-enough color. Structured enough for a studio, quick enough for
              a solo sprint.
            </p>
          </div>
          <div className="landing-feature-grid">
            {FEATURES.map((feature, index) => {
              const Icon = feature.icon;
              return (
                <article
                  className={`landing-feature tone-${feature.tone}${index === 0 ? " is-spotlight" : ""}`}
                  key={feature.title}
                >
                  <span className="landing-feature-index">{String(index + 1).padStart(2, "0")}</span>
                  <span className="landing-feature-icon">
                    <Icon size={18} />
                  </span>
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </article>
              );
            })}
          </div>
        </section>

        <section className="landing-ai" id="ai-actions">
          <div className="landing-ai-copy">
            <span className="landing-kicker tone-orange">
              <Bot size={13} /> AI actions
            </span>
            <h2>Talk to the board. It answers in task numbers.</h2>
            <p>
              The AI Actions panel sits in the top-right of your board. Pick a number from the live
              task list, describe the change, and review a plan that names every card it will touch.
            </p>
            <ul className="landing-checklist">
              <li>
                <CheckCircle2 size={14} /> Reference cards and subtasks by number
              </li>
              <li>
                <CheckCircle2 size={14} /> See the full plan before anything changes
              </li>
              <li>
                <CheckCircle2 size={14} /> Re-check every action against the live board
              </li>
              <li>
                <CheckCircle2 size={14} /> Keep a history of every plan and result
              </li>
            </ul>
            <button className="btn btn-primary btn-sm" type="button" onClick={() => go("/login?mode=create")}>
              Try it on your board <ArrowRight size={13} />
            </button>
          </div>

          <div className="landing-ai-art" aria-hidden="true">
            <div className="ai-mock-head">
              <span className="ai-mock-icon">
                <Sparkles size={14} />
              </span>
              <div>
                <b>AI Actions</b>
                <span>Describe a change by task number</span>
              </div>
              <span className="badge badge-green">AI ready</span>
            </div>
            <div className="ai-mock-prompt">
              Mark Task 261000005 as done and add subtask “Send invoice” to Task 261000004
            </div>
            <div className="ai-mock-chips">
              <span>261000004 · Draft launch note</span>
              <span>261000005 · Review pricing</span>
              <span>261000006 · Ship the beta</span>
            </div>
            <div className="ai-mock-plan">
              <span className="badge badge-green">Complete card</span>
              <b>Review pricing</b>
              <span>Doing → Done</span>
            </div>
            <div className="ai-mock-plan">
              <span className="badge badge-gold">Add subtask</span>
              <b>Send invoice</b>
              <span>on Task 261000004</span>
            </div>
            <div className="ai-mock-foot">
              <span>2 actions reviewed</span>
              <span className="mock-apply">
                <Play size={11} /> Apply plan
              </span>
            </div>
          </div>
        </section>

        <section className="landing-section" id="workflow">
          <div className="landing-section-head">
            <span className="landing-kicker tone-green">
              <History size={13} /> A three-step loop
            </span>
            <h2>Capture, point, apply.</h2>
            <p>The board stays the source of truth. AI is a careful assistant, not a loose cannon.</p>
          </div>
          <div className="landing-steps">
            {STEPS.map((item) => (
              <article className={`landing-step tone-${item.tone}`} key={item.step}>
                <span className="landing-step-number">{item.step}</span>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-keyboard" id="keyboard">
          <div className="landing-keyboard-copy">
            <span className="landing-kicker tone-orange">
              <Keyboard size={13} /> Keyboard-first
            </span>
            <h2>Keep your hands on the keys.</h2>
            <p>
              Capture a card, jump between columns, complete work, and open AI Actions without
              reaching for the mouse.
            </p>
          </div>
          <div className="landing-key-grid" aria-hidden="true">
            {[
              ["N", "New card"],
              ["/", "Filter"],
              ["1 2 3", "To Do · Doing · Done"],
              ["C", "Complete"],
              ["T", "Trash"],
              ["?", "Shortcuts"],
            ].map(([keys, label]) => (
              <div className="landing-key" key={keys}>
                <span>{keys}</span>
                <em>{label}</em>
              </div>
            ))}
          </div>
        </section>

        <section className="landing-quote">
          <blockquote>
            “The task number is the killer detail. I can say ‘mark 261000005 done’ out loud, in a
            meeting, and know exactly what will happen.”
          </blockquote>
          <div className="landing-quote-by">
            <span className="tenant-avatar">P</span>
            <div>
              <b>Early poca-note user</b>
              <span>Product studio owner</span>
            </div>
          </div>
        </section>

        <section className="landing-final">
          <div className="landing-final-glow" aria-hidden="true" />
          <span className="landing-eyebrow">
            <Cpu size={13} /> Your workspace is waiting
          </span>
          <h2>Make the board feel alive again.</h2>
          <p>
            Create a workspace in seconds. Bring your tasks, your numbers, and your next AI plan.
          </p>
          <div className="landing-hero-actions">
            <button className="btn btn-primary landing-cta" type="button" onClick={() => go("/login?mode=create")}>
              Create your workspace <ArrowRight size={15} />
            </button>
            <button className="btn btn-ghost landing-cta" type="button" onClick={() => go("/login")}>
              Sign in
            </button>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-footer-inner">
          <Brand onClick={go} />
          <p>Keyboard-first personal Kanban with AI actions that speak task numbers.</p>
          <span className="landing-footer-meta">
            <Palette size={13} /> Green · gold · orange
            <Moon size={13} /> Dark and light
          </span>
        </div>
      </footer>
    </div>
  );
}
