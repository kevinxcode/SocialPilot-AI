import { useCallback, useEffect, useState } from 'react';
import { getSettings, updateSettings, type DeepPartial } from '@/services/storage/settings';
import { translate, type TKey } from '@/i18n';
import type { Settings } from '@/types/models';

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    let alive = true;
    getSettings().then((s) => alive && setSettings(s));
    const onChange = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.settings) getSettings().then((s) => alive && setSettings(s));
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, []);
  const update = useCallback(async (patch: DeepPartial<Settings>) => {
    setSettings(await updateSettings(patch));
  }, []);
  return { settings, update };
}

export function useT() {
  const { settings } = useSettings();
  const lang = settings?.language ?? 'id';
  return useCallback((k: TKey) => translate(lang, k), [lang]);
}

export function useTheme(theme: Settings['theme'] | undefined) {
  useEffect(() => {
    const apply = () => {
      const dark = theme === 'dark' || (theme !== 'light' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
      document.documentElement.classList.toggle('dark', !!dark);
    };
    apply();
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener?.('change', apply);
    return () => mq?.removeEventListener?.('change', apply);
  }, [theme]);
}
