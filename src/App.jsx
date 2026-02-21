import ProjectView from './components/Project/ProjectView';

export default function App() {
  const projectPath = new URLSearchParams(window.location.search).get('project') || undefined;

  return <ProjectView projectPath={projectPath} />;
}
