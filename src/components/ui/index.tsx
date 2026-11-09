import * as React from 'react';
import { cn } from '@/lib/utils';

/* Small shadcn-style component set (Button, Card, Input, Textarea, Select, Label, Switch, Badge, Dialog, Tabs, Table, Toast). */

type Variant = 'default' | 'outline' | 'ghost' | 'destructive' | 'secondary';
type Size = 'default' | 'sm' | 'icon';
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}
const variants: Record<Variant, string> = {
  default: 'bg-primary text-primary-foreground hover:opacity-90',
  outline: 'border border-border bg-transparent hover:bg-muted',
  ghost: 'hover:bg-muted',
  destructive: 'bg-destructive text-white hover:opacity-90',
  secondary: 'bg-muted hover:opacity-90',
};
const sizes: Record<Size, string> = { default: 'h-9 px-4', sm: 'h-8 px-3 text-xs', icon: 'h-9 w-9' };

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition disabled:pointer-events-none disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = 'Button';

export function Card({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg border border-border bg-card p-4 shadow-sm', className)} {...p} />;
}
export function CardTitle({ className, ...p }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('mb-2 text-base font-semibold', className)} {...p} />;
}

const field =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary';
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...p }, ref) => <input ref={ref} className={cn(field, 'h-9', className)} {...p} />,
);
Input.displayName = 'Input';
export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...p }, ref) => <textarea ref={ref} className={cn(field, 'min-h-[80px]', className)} {...p} />,
);
Textarea.displayName = 'Textarea';
export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...p }, ref) => <select ref={ref} className={cn(field, 'h-9 py-1', className)} {...p} />,
);
Select.displayName = 'Select';
export function Label({ className, ...p }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('mb-1 block text-xs font-medium text-muted-foreground', className)} {...p} />;
}
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

export function Switch(props: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 rounded-full transition disabled:opacity-50',
        props.checked ? 'bg-primary' : 'border border-border bg-muted',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition',
          props.checked ? 'left-[18px]' : 'left-0.5',
        )}
      />
    </button>
  );
}

type Tone = 'default' | 'success' | 'warning' | 'danger' | 'info';
const tones: Record<Tone, string> = {
  default: 'bg-muted text-foreground',
  success: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  warning: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  danger: 'bg-red-500/15 text-red-600 dark:text-red-400',
  info: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
};
export function Badge({ tone = 'default', className, ...p }: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium', tones[tone], className)} {...p} />
  );
}

export function Dialog(props: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  if (!props.open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={props.onClose}>
      <div
        role="dialog"
        aria-label={props.title}
        className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-lg bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-lg font-semibold">{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}

export function Tabs<T extends string>(props: { value: T; onChange: (v: T) => void; items: { value: T; label: string }[] }) {
  return (
    <div role="tablist" className="inline-flex flex-wrap rounded-md bg-muted p-1">
      {props.items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="tab"
          aria-selected={props.value === it.value}
          onClick={() => props.onChange(it.value)}
          className={cn('rounded px-3 py-1 text-sm', props.value === it.value && 'bg-background shadow')}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function Table({ className, ...p }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto">
      <table
        className={cn(
          'w-full text-sm [&_td]:px-2 [&_td]:py-2 [&_th]:px-2 [&_th]:py-2 [&_th]:text-left [&_th]:text-xs [&_th]:text-muted-foreground [&_tr]:border-b [&_tr]:border-border',
          className,
        )}
        {...p}
      />
    </div>
  );
}

type ToastItem = { id: number; text: string; tone: 'ok' | 'err' };
const ToastCtx = React.createContext<(text: string, tone?: 'ok' | 'err') => void>(() => {});
export const useToast = () => React.useContext(ToastCtx);
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const push = React.useCallback((text: string, tone: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, text, tone }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 space-y-2">
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cn('rounded-md px-4 py-2 text-sm text-white shadow', t.tone === 'ok' ? 'bg-emerald-600' : 'bg-red-600')}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{children}</div>;
}
