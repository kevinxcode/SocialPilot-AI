import { closeSuggestions, editorMatches } from '@/services/publishing/rpa/dom';

afterEach(() => {
  delete (document as unknown as { execCommand?: unknown }).execCommand;
});

function editor(text: string) {
  document.body.innerHTML = `<div contenteditable="true" role="textbox">${text}</div>`;
  const box = document.querySelector('[role="textbox"]') as HTMLElement;
  const exec = vi.fn((cmd: string, _ui: boolean, value: string) => {
    if (cmd === 'insertText') box.textContent += value;
    return true;
  });
  (document as unknown as { execCommand: unknown }).execCommand = exec;
  return { box, exec };
}

test('text ending with a #hashtag → a space is typed at the end (closes the suggestion list); text still matches', async () => {
  const text = 'Jadwal shift rumit? Ini solusinya!\n\n#ManajemenKaryawan';
  const { box, exec } = editor(text);
  await closeSuggestions(box, text);
  expect(exec).toHaveBeenCalledWith('insertText', false, ' ');
  expect(box.textContent?.endsWith(' ')).toBe(true);
  expect(editorMatches(box, text)).toBe(true);
});

test('a suggestion list that is open for another reason is closed the same way', async () => {
  const { box, exec } = editor('Halo semua');
  document.body.insertAdjacentHTML('beforeend', '<ul role="listbox"><li role="option">#halo</li></ul>');
  await closeSuggestions(box, 'Halo semua');
  expect(exec).toHaveBeenCalledTimes(1);
});

test('normal text without a trailing tag and no list → nothing is typed', async () => {
  const { box, exec } = editor('Laundry rapi tanpa ribet.');
  await closeSuggestions(box, 'Laundry rapi tanpa ribet.');
  expect(exec).not.toHaveBeenCalled();
});
