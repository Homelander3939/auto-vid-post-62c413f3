import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useServerStatus() {
  return useQuery({
    queryKey: ['server-health'],
    queryFn: () => api.health(),
    retry: false,
    refetchInterval: 10000,
  });
}
