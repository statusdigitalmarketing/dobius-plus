import ProjectView from './components/Project/ProjectView';
import ProjectList from './components/Launcher/ProjectList';

export default function App() {
  const projectPath = new URLSearchParams(window.location.search).get('project') || undefined;

  // If no project path in URL, show the Launcher. Otherwise show the Project view.
  if (!projectPath) {
    return <ProjectList />;
  }

  return <ProjectView projectPath={projectPath} />;
}
