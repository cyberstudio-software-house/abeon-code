import { Redirect } from 'expo-router';
import { useStore } from '@/src/store';
import { redirectTarget } from '@/src/lib/nav';

export default function Index() {
  const status = useStore((s) => s.status);
  return <Redirect href={redirectTarget(status)} />;
}
