// Cycles light → dark → system. Compact pill suitable for the sidebar footer.
import { Sun, Moon, Monitor } from 'lucide-react';
import { useTheme, type Theme } from '@/lib/theme';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const ORDER: Theme[] = ['light', 'dark', 'system'];
const META: Record<Theme, { icon: typeof Sun; label: string; hint: string }> = {
  light: { icon: Sun, label: 'Light', hint: 'Switch to dark' },
  dark: { icon: Moon, label: 'Dark', hint: 'Switch to system' },
  system: { icon: Monitor, label: 'System', hint: 'Switch to light' },
};

export default function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const cur = META[theme];
  const Icon = cur.icon;

  const next = () => {
    const idx = ORDER.indexOf(theme);
    setTheme(ORDER[(idx + 1) % ORDER.length]);
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={next}
          aria-label={`Theme: ${cur.label}. ${cur.hint}`}
          className={cn(
            'flex items-center gap-2 w-full px-3 py-2 rounded-lg text-xs font-medium transition-all border',
            'bg-secondary/60 border-border text-foreground/80 hover:bg-secondary hover:text-foreground',
            className,
          )}
        >
          <Icon className="w-4 h-4" />
          <span>{cur.label} theme</span>
          <span className="ml-auto flex gap-0.5 opacity-60">
            {ORDER.map((t) => (
              <span
                key={t}
                className={cn('h-1.5 w-1.5 rounded-full', t === theme ? 'bg-primary' : 'bg-muted-foreground/40')}
              />
            ))}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-[220px]">
        {cur.hint}
      </TooltipContent>
    </Tooltip>
  );
}
