// Tests for spoken file and folder authoring.
//
// These commands write to disk and launch programs, so the parser is a
// security boundary as much as the path validator is: everything downstream
// trusts the filename and location it produces. The cases below are the ones
// that were actually wrong during development, plus the ones that must never
// match — a question about files is not an instruction to create one.
import {
    parseFileCommand, sanitiseName, detectLanguage, inferCodeFilename,
} from '../fileCommands.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

// --- folders ----------------------------------------------------------------
const folder = parseFileCommand('create a folder called notes on the desktop');
check('folder: parsed', folder?.kind === 'create-folder');
check('folder: name', folder?.name === 'notes');
check('folder: location', folder?.location === 'desktop');

check('folder: wake word tolerated',
    parseFileCommand('jarvis create a folder my project in documents')?.location === 'documents');
check('folder: "directory" synonym',
    parseFileCommand('make a new directory called screenshots in pictures')?.kind === 'create-folder');
check('folder: "add a new folder named"',
    parseFileCommand('add a new folder named archive in downloads')?.name === 'archive');
check('folder: defaults to desktop',
    parseFileCommand('create a folder called scratch')?.location === 'desktop');

// --- files ------------------------------------------------------------------
check('file: keeps a spoken extension',
    parseFileCommand('create a file called todo.txt on the desktop')?.name === 'todo.txt');
check('file: adds .txt when none spoken',
    parseFileCommand('create a file called notes')?.name === 'notes.txt');

const withContent = parseFileCommand('make a file called shopping list saying Milk and Eggs');
check('file: content captured', withContent?.content === 'Milk and Eggs');
check('file: content keeps its casing', withContent?.content === 'Milk and Eggs');
check('file: spaces become hyphens', withContent?.name === 'shopping-list.txt');

// Regression: produced `shopping-list-in-documents.txt`. The location strip was
// anchored to the end of the string, and here the location sits in the middle.
const midLocation = parseFileCommand('make a file called shopping list in documents saying milk and eggs');
check('file: location does not leak into the name', midLocation?.name === 'shopping-list.txt');
check('file: location still detected', midLocation?.location === 'documents');

// "meet me in documents" is part of the note, not where to save it.
const contentMentionsFolder = parseFileCommand('make a file called notes saying meet me in documents at five');
check('file: a location inside CONTENT does not pick the folder',
    contentMentionsFolder?.location === 'desktop');
check('file: that content survives intact',
    contentMentionsFolder?.content === 'meet me in documents at five');

// --- code -------------------------------------------------------------------
const code = parseFileCommand('open vscode and write code to sort binary search in java');
check('code: parsed', code?.kind === 'write-code');
check('code: language', code?.language.ext === 'java');
check('code: editor', code?.openIn === 'vscode');
check('code: prompt keeps the subject', /binary search/.test(code?.prompt || ''));
check('code: language stripped from the prompt', !/\bin java\b/.test(code?.prompt || ''));

check('code: "vs code" as two words',
    parseFileCommand('open vs code and write a quicksort in python')?.openIn === 'vscode');
check('code: notepad',
    parseFileCommand('open notepad and write a hello world in python')?.openIn === 'notepad');
check('code: no editor means write but do not open',
    parseFileCommand('write a quicksort in python on the desktop')?.openIn === null);

// Regression: produced `bubblesort` — lowercased and extensionless. Java
// resolves the public class by filename, so that file does not compile.
check('code: explicit name keeps casing and gains the extension',
    parseFileCommand('jarvis write a bubble sort in java called BubbleSort')?.name === 'BubbleSort.java');

check('lang: javascript is not java', detectLanguage('write a debounce in javascript')?.ext === 'js');
check('lang: java is not javascript', detectLanguage('write a stack in java')?.ext === 'java');
check('lang: none detected for prose', detectLanguage('write a poem about the sea') === null);

// --- must NOT match ---------------------------------------------------------
for (const phrase of [
    'what folders are on my desktop',
    'tell me about binary search',
    'how do i create a folder in windows',
    'what is in my documents folder',
]) check(`ignores question: "${phrase}"`, parseFileCommand(phrase) === null);

// "write me a poem" must not create a file — no language, so not a code request.
check('ignores a prose write request', parseFileCommand('write me a poem about the sea') === null);
for (const junk of ['', '   ', 'jarvis'])
    check(`ignores junk: ${JSON.stringify(junk)}`, parseFileCommand(junk) === null);

// --- name sanitising --------------------------------------------------------
check('name: strips filesystem-special characters',
    !/[<>:"/\\|?*]/.test(sanitiseName('my<>:"/\\|?*file') || ''));

// A file called `untitled` appearing because a name was misheard is worse than
// being told the name was not understood.
check('name: null rather than an invented fallback', sanitiseName('***') === null);
check('name: null for whitespace', sanitiseName('   ') === null);

// Windows silently strips these, so the created file would not match the name
// confirmed aloud.
check('name: drops trailing dots', sanitiseName('report...') === 'report');
check('name: drops trailing spaces', sanitiseName('report   ') === 'report');

for (const reserved of ['CON', 'con', 'PRN', 'aux', 'NUL', 'COM1', 'LPT9', 'con.txt'])
    check(`name: refuses reserved device "${reserved}"`, sanitiseName(reserved) === null);

check('name: spoken "dot" becomes a period', sanitiseName('todo dot txt') === 'todo.txt');
check('name: spoken "underscore"', sanitiseName('my underscore file') === 'my_file');
check('name: long names are truncated, not rejected',
    (sanitiseName('a'.repeat(300)) || '').length <= 120);

// --- inferred filenames -----------------------------------------------------
check('infer: PascalCase for Java',
    inferCodeFilename('binary search', { ext: 'java' }) === 'BinarySearch.java');
check('infer: snake_case elsewhere',
    inferCodeFilename('binary search', { ext: 'py' }) === 'binary_search.py');

const inferred = inferCodeFilename('a program to implement the quicksort algorithm', { ext: 'py' });
check('infer: drops filler words', !/\b(a|the|to|program|algorithm)\b/.test(inferred));
check('infer: keeps the subject', inferred.includes('quicksort'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
