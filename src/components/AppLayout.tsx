import { NavLink, Outlet } from 'react-router-dom';
import { Settings, LayoutDashboard, Upload, Clock, BookOpen, MessageSquare, Wifi, WifiOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEffect, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/queue', icon: Upload, label: 'Upload Queue' },
  { to: '/schedule', icon: Clock, label: 'Schedule' },
  { to: '/chat', icon: MessageSquare, label: 'AI Chat' },
  { to: '/settings', icon: Settings, label: 'Settings' },
  { to: '/setup', icon: BookOpen, label: 'Setup Guide' },
];

type ServerStatus = 'connected' | 'disconnected' | 'checking';

function useLocalServerStatus() {
  const [status, setStatus] = useState<ServerStatus>('checking');

  useEffect(() => {
    let mounted = true;
    const check = async () => {
      try {
        const resp = await fetch('http://localhost:3001/health', { signal: AbortSignal.timeout(3000) });
        if (mounted) setStatus(resp.ok ? 'connected' : 'disconnected');
      } catch {
        if (mounted) setStatus('disconnected');
      }
    };
    check();
    const interval = setInterval(check, 10000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);

  return status;
}

export default function AppLayout() {
  const serverStatus = useLocalServerStatus();

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="w-64 shrink-0 border-r bg-card flex flex-col">
        <div className="p-6 pb-4">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            Video Uploader
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            YouTube · TikTok · Instagram
          </p>
        </div>

        <nav className="flex-1 px-3 space-y-1">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                )
              }
            >
              <Icon className="w-4 h-4" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="p-4 border-t space-y-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-2 cursor-default">
                {serverStatus === 'connected' ? (
                  <>
                    <span className="relative flex h-2.5 w-2.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
                    </span>
                    <span className="text-xs text-emerald-600 font-medium">Local server connected</span>
                  </>
                ) : serverStatus === 'checking' ? (
                  <>
                    <span className="h-2.5 w-2.5 rounded-full bg-amber-400 animate-pulse" />
                    <span className="text-xs text-muted-foreground">Checking server…</span>
                  </>
                ) : (
                  <>
                    <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/40" />
                    <span className="text-xs text-muted-foreground">Local server offline</span>
                  </>
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-[220px]">
              {serverStatus === 'connected'
                ? 'Your local PC is running the upload server. Uploads will be processed via browser automation.'
                : 'Start the local server on your PC to process uploads. See Setup Guide for instructions.'}
            </TooltipContent>
          </Tooltip>
          <p className="text-xs text-muted-foreground">
            Cloud DB · Local uploads
          </p>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
