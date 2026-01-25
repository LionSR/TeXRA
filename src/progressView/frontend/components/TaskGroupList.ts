// Third-party imports
import { customElement } from 'lit/decorators.js';

// Local imports - progress view components
import { LogList } from './LogList';

@customElement('task-group-list')
export class TaskGroupList extends LogList {}
