import { useRef, type ReactNode } from 'react';
import { Download, Upload } from 'lucide-react';
import { Button, Card, CardTitle, Field, Input, Select, Switch, useToast } from '@/components/ui';
import { useSettings } from '@/hooks/useSettings';
import { exportAll, importAll } from '@/services/storage/exportImport';
import type { Language, Settings } from '@/types/models';

const TIMEZONES = ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura', 'Asia/Singapore', 'UTC'];

export function SettingsPage({ extra }: { extra?: ReactNode }) {
  const { settings, update } = useSettings();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  if (!settings) return null;

  const doExport = async () => {
    const blob = await exportAll();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `socialpilot-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const doImport = async (f: File | undefined) => {
    if (!f) return;
    try {
      await importAll(f);
      toast('Import complete');
    } catch (e) {
      toast(`Import rejected: ${(e as Error).message.slice(0, 120)}`, 'err');
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle>General</CardTitle>
        <div className="grid gap-4 md:grid-cols-4">
          <Field label="Language">
            <Select value={settings.language} onChange={(e) => update({ language: e.target.value as Language })}>
              <option value="id">Bahasa Indonesia</option>
              <option value="en">English</option>
            </Select>
          </Field>
          <Field label="Theme">
            <Select value={settings.theme} onChange={(e) => update({ theme: e.target.value as Settings['theme'] })}>
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </Select>
          </Field>
          <Field label="Timezone">
            <Select value={settings.timezone} onChange={(e) => update({ timezone: e.target.value })}>
              {TIMEZONES.map((tz) => (
                <option key={tz}>{tz}</option>
              ))}
            </Select>
          </Field>
          <Field label="Auto-pick an image when a post has none">
            <div className="flex h-9 items-center">
              <Switch checked={settings.autoPickMedia} onChange={(v) => update({ autoPickMedia: v })} label="Auto-pick image" />
            </div>
          </Field>
          <Field label="Gap between posts to different Facebook Groups (min)">
            <Input
              type="number"
              min={15}
              value={settings.groupGapMinutes}
              onChange={(e) => update({ groupGapMinutes: Math.max(15, Number(e.target.value) || 30) })}
            />
          </Field>
          <Field label="Minimum gap between posts per platform (min)">
            <Input
              type="number"
              min={10}
              value={settings.minGapMinutes}
              onChange={(e) => update({ minGapMinutes: Math.max(10, Number(e.target.value) || 60) })}
            />
          </Field>
        </div>
      </Card>
      {extra}
      <Card>
        <CardTitle>Backup</CardTitle>
        <p className="mb-3 text-sm text-muted-foreground">
          Export includes brands, knowledge, ideas, posts, queue, usage and logs. Media files and API keys are not exported.
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={doExport}>
            <Download className="h-4 w-4" /> Export JSON
          </Button>
          <Button variant="outline" onClick={() => fileRef.current?.click()}>
            <Upload className="h-4 w-4" /> Import JSON
          </Button>
          <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => doImport(e.target.files?.[0])} />
        </div>
      </Card>
    </div>
  );
}
