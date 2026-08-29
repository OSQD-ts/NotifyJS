import { useColorScheme } from 'react-native';

/** Mirrors the dashboard's palette so both clients look like one product. */
const light = {
  bg: '#f6f7f9',
  surface: '#ffffff',
  surface2: '#f0f2f5',
  border: '#dfe3e8',
  text: '#14181f',
  muted: '#626b78',
  accent: '#2f6df6',
};

const dark = {
  bg: '#0e1116',
  surface: '#161b22',
  surface2: '#1c222b',
  border: '#2a313c',
  text: '#e8ecf1',
  muted: '#9aa4b2',
  accent: '#5b8cff',
};

export const SEVERITY_COLORS = {
  debug: '#8a93a0',
  info: '#5b8cff',
  success: '#35c48a',
  warning: '#e0a33a',
  error: '#ff6b6b',
  critical: '#e07be0',
} as const;

export type Theme = typeof light & { isDark: boolean };

export function useTheme(): Theme {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  return { ...(isDark ? dark : light), isDark };
}
