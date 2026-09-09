import { registerRootComponent } from 'expo'
import App from './src/App'
// Must be imported here (unconditionally, at startup) so expo-task-manager's
// background location task is defined before any headless relaunch by the OS.
import './src/tasks/locationTask'

registerRootComponent(App)
