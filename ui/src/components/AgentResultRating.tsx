import { useEffect, useId, useState } from "react";
import {
  addAgentLesson,
  loadAgentResultRating,
  saveAgentResultRating,
  type AgentResultRating,
} from "../lib/agentLessons";
import styles from "./AgentFeedbackBubble.module.css";

const empty: AgentResultRating = { thumb: null, stars: null, correction: "", savedAsLesson: false, updatedAtUnixMs: 0 };

/** Rates one agent result. A correction can become a lesson for later requests. */
export function AgentResultRatingPanel({ ratingId, sourceLabel }: { ratingId: string; sourceLabel: string }) {
  const [rating, setRating] = useState<AgentResultRating>(() => loadAgentResultRating(ratingId) ?? empty);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const correctionId = useId();
  useEffect(() => { setRating(loadAgentResultRating(ratingId) ?? empty); }, [ratingId]);

  const save = (next: AgentResultRating) => {
    const stored = { ...next, updatedAtUnixMs: Date.now() };
    setRating(stored);
    setStatus(saveAgentResultRating(ratingId, stored) ? "Rating saved." : "Could not save the rating on this device.");
    return stored;
  };
  const saveLesson = () => {
    const lesson = addAgentLesson(rating.correction, sourceLabel);
    if (!lesson) { setStatus("Could not save the lesson."); return; }
    save({ ...rating, savedAsLesson: true });
    setStatus("Lesson saved. New agent requests include it.");
  };

  return <div className={styles.rating} role="group" aria-label="Rate this result">
    <div className={styles.ratingRow}>
      <span className={styles.ratingLabel}>Rate this result</span>
      <button aria-label="Good result" aria-pressed={rating.thumb === "up"} className={styles.thumb} data-tone="up" onClick={() => { save({ ...rating, thumb: rating.thumb === "up" ? null : "up" }); }} type="button">👍</button>
      <button aria-label="Poor result" aria-pressed={rating.thumb === "down"} className={styles.thumb} data-tone="down" onClick={() => { save({ ...rating, thumb: rating.thumb === "down" ? null : "down" }); setOpen(true); }} type="button">👎</button>
      <span className={styles.stars} role="group" aria-label="Quality from 1 to 5">
        {[1, 2, 3, 4, 5].map((value) => <button aria-pressed={rating.stars === value} aria-label={value + " of 5"} className={styles.star} data-filled={(rating.stars ?? 0) >= value || undefined} key={value} onClick={() => save({ ...rating, stars: rating.stars === value ? null : value })} type="button">★</button>)}
      </span>
      <button aria-expanded={open} className={styles.ratingToggle} onClick={() => setOpen((current) => !current)} type="button">{rating.correction ? "Edit correction" : "Add correction"}</button>
    </div>
    {open && <div className={styles.correction}>
      <label htmlFor={correctionId}>What did the agent do wrong?</label>
      <textarea id={correctionId} maxLength={600} placeholder="Example: The agent added a new import. Use the existing helper." value={rating.correction} onChange={(event) => setRating({ ...rating, correction: event.target.value, savedAsLesson: false })} />
      <div className={styles.actions}>
        <button onClick={() => save(rating)} type="button">Save correction</button>
        <button className={styles.send} disabled={!rating.correction.trim() || rating.savedAsLesson} onClick={saveLesson} type="button">{rating.savedAsLesson ? "Saved as lesson" : "Save as lesson for later tasks"}</button>
      </div>
    </div>}
    {status && <p className={styles.ratingStatus} role="status">{status}</p>}
  </div>;
}

export function AgentLessonsList({ lessons, onRemove }: { lessons: readonly { id: string; text: string; sourceLabel: string }[]; onRemove: (id: string) => void }) {
  if (!lessons.length) return <p className={styles.muted}>No lessons yet. Rate a result and save a correction as a lesson.</p>;
  return <ul className={styles.lessons} aria-label="Saved lessons">
    {lessons.map((lesson) => <li key={lesson.id}><span>{lesson.text}</span><small>{lesson.sourceLabel}</small><button aria-label={"Remove lesson: " + lesson.text} onClick={() => onRemove(lesson.id)} type="button">Remove</button></li>)}
  </ul>;
}

