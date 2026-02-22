import { useEffect } from 'react';
import ProjectView from './components/Project/ProjectView';
import ProjectList from './components/Launcher/ProjectList';
import ErrorBoundary from './components/shared/ErrorBoundary';

export default function App() {
  const projectPath = new URLSearchParams(window.location.search).get('project') || undefined;

  // Handle file drag-and-drop globally.
  // dragover: preventDefault enables drop target behaviour.
  // drop: extract file paths and relay them via a custom event so the active
  // TerminalPane can insert them into the command input. Also prevents
  // Electron from navigating to the dropped file.
  useEffect(() => {
    const preventDragOver = (e) => { e.preventDefault(); };
    const handleDrop = (e) => {
      e.preventDefault();
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        const paths = Array.from(files).map((f) => {
          try { return window.electronAPI?.getPathForFile?.(f); } catch { return ''; }
        }).filter(Boolean);
        if (paths.length > 0) {
          window.dispatchEvent(new CustomEvent('dobius:drop-files', { detail: { paths } }));
        }
      }
    };
    document.addEventListener('dragover', preventDragOver, true);
    document.addEventListener('drop', handleDrop, true);
    return () => {
      document.removeEventListener('dragover', preventDragOver, true);
      document.removeEventListener('drop', handleDrop, true);
    };
  }, []);

  // If no project path in URL, show the Launcher. Otherwise show the Project view.
  if (!projectPath) {
    return (
      <ErrorBoundary>
        <ProjectList />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <ProjectView projectPath={projectPath} />
    </ErrorBoundary>
  );
}
