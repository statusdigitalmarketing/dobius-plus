import { useEffect } from 'react';
import ProjectView from './components/Project/ProjectView';
import ProjectList from './components/Launcher/ProjectList';
import ErrorBoundary from './components/shared/ErrorBoundary';

export default function App() {
  const projectPath = new URLSearchParams(window.location.search).get('project') || undefined;

  // Prevent Electron from navigating when files are dragged onto the window.
  // Without this, dropping a file anywhere outside a handled zone causes the
  // webContents to load the file URL, destroying the React app.
  useEffect(() => {
    const prevent = (e) => { e.preventDefault(); };
    document.addEventListener('dragover', prevent);
    document.addEventListener('drop', prevent);
    return () => {
      document.removeEventListener('dragover', prevent);
      document.removeEventListener('drop', prevent);
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
