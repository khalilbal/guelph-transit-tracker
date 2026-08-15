import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        ink: '#0f172a',
        paper: '#f7f7f2',
        accent: '#ff6b35',
        pine: '#073b4c',
        moss: '#2f6f5e',
        gold: '#f4c95d',
        mist: '#dbe7e4',
      },
      boxShadow: {
        glow: '0 20px 60px rgba(7, 59, 76, 0.18)',
      },
      backgroundImage: {
        grain: 'radial-gradient(circle at top, rgba(255,255,255,0.22), transparent 42%), linear-gradient(135deg, rgba(255, 107, 53, 0.10), rgba(7, 59, 76, 0.14))',
      },
      animation: {
        float: 'float 6s ease-in-out infinite',
        pulseSoft: 'pulseSoft 2.4s ease-in-out infinite',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-6px)' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '0.6' },
          '50%': { opacity: '1' },
        },
      },
    },
  },
  darkMode: ['class'],
  plugins: [],
};

export default config;
