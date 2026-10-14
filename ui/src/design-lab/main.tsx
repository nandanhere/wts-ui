import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import { AgentLab } from './AgentLab';
import './styles.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><AgentLab /></React.StrictMode>);
