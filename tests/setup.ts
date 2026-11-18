import 'fake-indexeddb/auto';
import { installChromeMock } from './chromeMock';
installChromeMock();

// jsdom has no object URLs; pages that preview media blobs need them.
if (!URL.createObjectURL) URL.createObjectURL = () => 'blob:jsdom';
if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};
