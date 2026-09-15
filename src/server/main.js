/* Server entry point.
 *
 * The collection is declared in both/scores.js so the client and server agree
 * on its name; the server half adds validation, rate limiting and the boards.
 */
import '../both/scores.js';
import './scores.js';
