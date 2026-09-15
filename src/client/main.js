/* Client entry point.
 *
 * With `meteor.mainModule` set, ONLY files reachable from an entry are loaded —
 * the classic "everything under client/ is auto-loaded" convention stops
 * applying. So every client file is imported here, in order.
 *
 * Order matters: templates.html defines Template.ApplicationHome before
 * logic.js attaches its onRendered hook to it.
 */
import './templates.html';
import './styles.css';
import '../both/scores.js';
import './logic.js';
import './scores.js';
import './settings.js';
