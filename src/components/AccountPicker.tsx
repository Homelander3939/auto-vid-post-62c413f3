import { useQuery } from '@tanstack/react-query';
import { getPlatformAccounts, type PlatformAccount } from '@/lib/storage';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Star } from 'lucide-react';

interface AccountPickerProps {
  platform: string;
  selectedAccountId: string | undefined;
  onSelect: (accountId: string) => void;
}

export function useAccountsForPlatforms(platforms: string[]) {
  const { data: allAccounts = [] } = useQuery({
    queryKey: ['platform_accounts'],
    queryFn: getPlatformAccounts,
  });

  const accountsByPlatform: Record<string, PlatformAccount[]> = {};
  for (const p of platforms) {
    accountsByPlatform[p] = allAccounts.filter((a) => a.platform === p && a.enabled);
  }

  // Returns the default or first enabled account for a platform
  const getDefaultAccountId = (platform: string): string | undefined => {
    const platformAccounts = accountsByPlatform[platform] || [];
    const defaultAcc = platformAccounts.find((a) => a.is_default);
    return defaultAcc?.id || platformAccounts[0]?.id;
  };

  // Check if any platform has multiple accounts (needs picker)
  const needsPicker = platforms.some((p) => (accountsByPlatform[p]?.length || 0) > 1);

  return { allAccounts, accountsByPlatform, getDefaultAccountId, needsPicker };
}

export default function AccountPicker({ platform, selectedAccountId, onSelect }: AccountPickerProps) {
  const { data: allAccounts = [] } = useQuery({
    queryKey: ['platform_accounts'],
    queryFn: getPlatformAccounts,
  });

  const accounts = allAccounts.filter((a) => a.platform === platform && a.enabled);

  if (accounts.length <= 1) return null;

  return (
    <div className="space-y-1">
      <Label className="text-xs capitalize">{platform} Account</Label>
      <Select value={selectedAccountId || ''} onValueChange={onSelect}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue placeholder="Select account" />
        </SelectTrigger>
        <SelectContent>
          {accounts.map((acc) => (
            <SelectItem key={acc.id} value={acc.id} className="text-xs">
              <span className="flex items-center gap-1.5">
                {acc.label || acc.email}
                {acc.is_default && <Star className="w-3 h-3 fill-current text-amber-500" />}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
