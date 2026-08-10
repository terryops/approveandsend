import { describe, expect, it } from 'vitest';

import { newlines } from './text';

describe('newlines', () => {
  it('turns what a textarea submits into what the model writes', () => {
    // The exact pair that broke Put this back: one reply, two spellings.
    const typed = '你来过三次了，所以直接问一句：要不要买车？\r\n\r\n想聊的话，回这封邮件就行。';
    const drafted = '你来过三次了，所以直接问一句：要不要买车？\n\n想聊的话，回这封邮件就行。';

    expect(typed).not.toBe(drafted);
    expect(newlines(typed)).toBe(drafted);
  });

  it('takes the lone carriage return too', () => {
    expect(newlines('one\rtwo')).toBe('one\ntwo');
  });

  it('leaves text that is already right alone', () => {
    const already = 'one\ntwo\n\nthree';
    expect(newlines(already)).toBe(already);
  });

  it('does not touch a carriage return that is not a line break', () => {
    // `\r` inside a run it does not end is still a line break; there is no such
    // thing as a decorative CR. This pins the behaviour rather than an
    // exception: every `\r` becomes exactly one `\n`, never two.
    expect(newlines('a\r\n\rb')).toBe('a\n\nb');
  });
});
