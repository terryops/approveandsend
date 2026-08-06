import { describe, expect, it } from 'vitest';

import { openDb } from '../db';

import { gradeRisk } from './risk';
import { createTask, getTask, updateTask } from './store';
import type { Analysis, Sentiment } from './types';

function analysis(sentiment: Sentiment): Analysis {
  return { intent: 'Wants a refund', language: 'en', sentiment, keyPoints: [], suggestedActions: [] };
}

describe('gradeRisk', () => {
  it('grades a clean draft on a happy email as routine', () => {
    expect(
      gradeRisk({
        analysis: analysis('neutral'),
        criticApproved: true,
        appliedRules: 3,
        haveRules: true,
        threadLength: 1,
      }),
    ).toEqual({ level: 'low', factors: [] });
  });

  it('is high when the critic refused to sign it off', () => {
    const risk = gradeRisk({ analysis: analysis('neutral'), criticApproved: false });

    expect(risk.level).toBe('high');
    expect(risk.factors).toContain('criticRejected');
  });

  it('is high for an angry customer even with a clean draft', () => {
    // The grade is about what it costs to be wrong, not about whether we are.
    expect(gradeRisk({ analysis: analysis('angry'), criticApproved: true }).level).toBe('high');
  });

  it('treats no critic pass as no evidence either way', () => {
    // An install running without a critic to halve its bill must not end up
    // with every single draft flagged.
    expect(gradeRisk({ analysis: analysis('neutral') })).toEqual({ level: 'low', factors: [] });
  });

  it('separates unhappy from angry', () => {
    const risk = gradeRisk({ analysis: analysis('negative'), criticApproved: true });

    expect(risk).toEqual({ level: 'normal', factors: ['unhappy'] });
  });

  it('flags a draft no rule covered', () => {
    const risk = gradeRisk({
      analysis: analysis('neutral'),
      criticApproved: true,
      appliedRules: 0,
      haveRules: true,
    });

    expect(risk).toEqual({ level: 'normal', factors: ['noRules'] });
  });

  it('says nothing about rules on a desk that has none', () => {
    // Every draft on a fresh install is unruled. Flagging all of them would
    // make the badge mean "this product is new".
    const risk = gradeRisk({
      analysis: analysis('neutral'),
      criticApproved: true,
      appliedRules: 0,
      haveRules: false,
    });

    expect(risk.factors).not.toContain('noRules');
  });

  it('flags a conversation that has been going back and forth', () => {
    const risk = gradeRisk({ analysis: analysis('neutral'), criticApproved: true, threadLength: 4 });

    expect(risk).toEqual({ level: 'normal', factors: ['longThread'] });
  });

  it('does not flag a thread that is still short', () => {
    expect(
      gradeRisk({ analysis: analysis('neutral'), criticApproved: true, threadLength: 3 }).level,
    ).toBe('low');
  });

  it('collects every reason, not only the one that set the level', () => {
    const risk = gradeRisk({
      analysis: analysis('angry'),
      criticApproved: false,
      appliedRules: 0,
      haveRules: true,
      threadLength: 6,
    });

    expect(risk.level).toBe('high');
    expect(risk.factors).toEqual(['criticRejected', 'angry', 'noRules', 'longThread']);
  });

  it('grades a task with no analysis at all', () => {
    expect(gradeRisk({}).level).toBe('low');
  });
});

describe('storing a grade', () => {
  it('round-trips the level and its reasons', () => {
    const db = openDb(':memory:');
    const { task } = createTask({ subject: 'Refund?', fromAddress: 'sam@example.com' }, db);

    updateTask(task.id, { risk: { level: 'high', factors: ['angry', 'noRules'] } }, db);

    expect(getTask(task.id, db)?.risk).toEqual({ level: 'high', factors: ['angry', 'noRules'] });
    db.close();
  });

  it('reads an ungraded task as null rather than low', () => {
    // "Nobody has looked at this" and "we looked and it is fine" are different
    // things, and a badge is the wrong place to conflate them.
    const db = openDb(':memory:');
    const { task } = createTask({ subject: 'Hello', fromAddress: 'sam@example.com' }, db);

    expect(getTask(task.id, db)?.risk).toBeNull();
    db.close();
  });

  it('drops a factor it does not recognise', () => {
    const db = openDb(':memory:');
    const { task } = createTask({ subject: 'Hello', fromAddress: 'sam@example.com' }, db);
    db.prepare(`UPDATE tasks SET risk_level = 'high', risk_factors = ? WHERE id = ?`).run(
      JSON.stringify(['angry', 'chargeback']),
      task.id,
    );

    expect(getTask(task.id, db)?.risk?.factors).toEqual(['angry']);
    db.close();
  });

  it('keeps the grade when the reasons are unreadable', () => {
    const db = openDb(':memory:');
    const { task } = createTask({ subject: 'Hello', fromAddress: 'sam@example.com' }, db);
    db.prepare(`UPDATE tasks SET risk_level = 'high', risk_factors = 'not json' WHERE id = ?`).run(
      task.id,
    );

    expect(getTask(task.id, db)?.risk).toEqual({ level: 'high', factors: [] });
    db.close();
  });
});
