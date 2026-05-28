// Registers all design-mock custom elements as a side-effect import.
// Importing this module makes the following tags available in the DOM:
//   <texra-yolo-toggle-mock>
//   <texra-context-utilization-mock>
//   <texra-todo-list-mock>
//   <texra-followup-controls-mock>
//   <texra-progress-board-layout-mock>
//   <texra-mocks-gallery>
//
// To view the gallery in the main webview, open DevTools and run:
//   localStorage.setItem('texra-mocks', '1'); location.reload();
// To exit:
//   localStorage.removeItem('texra-mocks'); location.reload();

// Side-effect imports - gallery root and its child mock custom elements
import './MocksGallery';
