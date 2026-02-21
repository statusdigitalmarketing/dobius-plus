import ProjectView from './components/Project/ProjectView';
import ProjectList from './components/Launcher/ProjectList';
import ErrorBoundary from './components/shared/ErrorBoundary';

export default function App() {
  const projectPath = new URLSearchParams(window.location.search).get('project') || undefined;

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
