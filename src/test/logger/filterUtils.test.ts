// Standard library imports
import { strict as assert } from 'assert';
import * as vscode from 'vscode';

// Local imports
import { getEmitFilter } from '@logger/filterUtils';
import { MESSAGE_TYPES } from '@logger/messageTypes';

describe('getEmitFilter', () => {
  let originalConfig: any;

  beforeEach(() => {
    // Store original config
    originalConfig = vscode.workspace.getConfiguration('texra.logger');
  });

  afterEach(() => {
    // Restore original config if needed
  });

  describe('debug mode filtering', () => {
    it('filters debug-level messages when debug mode is off', () => {
      // Mock debug mode off (default)
      const result = getEmitFilter({
        level: 'debug',
        messageType: MESSAGE_TYPES.DEFAULT,
      });
      assert.equal(
        result.shouldEmit,
        false,
        'Debug messages should be filtered when debug mode is off',
      );
    });

    it('allows info-level messages when debug mode is off', () => {
      const result = getEmitFilter({
        level: 'info',
        messageType: MESSAGE_TYPES.DEFAULT,
      });
      assert.equal(
        result.shouldEmit,
        true,
        'Info messages should pass through when debug mode is off',
      );
    });

    it('allows warn-level messages when debug mode is off', () => {
      const result = getEmitFilter({
        level: 'warn',
        messageType: MESSAGE_TYPES.DEFAULT,
      });
      assert.equal(
        result.shouldEmit,
        true,
        'Warn messages should pass through when debug mode is off',
      );
    });

    it('allows error-level messages when debug mode is off', () => {
      const result = getEmitFilter({
        level: 'error',
        messageType: MESSAGE_TYPES.DEFAULT,
      });
      assert.equal(
        result.shouldEmit,
        true,
        'Error messages should pass through when debug mode is off',
      );
    });
  });

  describe('INTERNAL message filtering', () => {
    it('always filters INTERNAL messages regardless of level', () => {
      const levels: Array<'debug' | 'info' | 'warn' | 'error'> = [
        'debug',
        'info',
        'warn',
        'error',
      ];

      for (const level of levels) {
        const result = getEmitFilter({
          level,
          messageType: MESSAGE_TYPES.INTERNAL,
        });
        assert.equal(
          result.shouldEmit,
          false,
          `INTERNAL messages at ${level} level should always be filtered`,
        );
      }
    });
  });

  describe('normal message types', () => {
    const normalTypes = [
      MESSAGE_TYPES.THINKING,
      MESSAGE_TYPES.MODEL_RESPONSE,
      MESSAGE_TYPES.SCRATCHPAD,
      MESSAGE_TYPES.FILE_LIST,
      MESSAGE_TYPES.ERROR,
      MESSAGE_TYPES.PROGRESS_STATUS,
      MESSAGE_TYPES.USER_MESSAGE,
      MESSAGE_TYPES.DEFAULT,
    ];

    it('allows all non-debug level messages for normal message types', () => {
      for (const messageType of normalTypes) {
        const result = getEmitFilter({
          level: 'info',
          messageType,
        });
        assert.equal(
          result.shouldEmit,
          true,
          `${messageType} messages at info level should pass through`,
        );
      }
    });

    it('filters debug level messages for normal message types when debug mode is off', () => {
      for (const messageType of normalTypes) {
        const result = getEmitFilter({
          level: 'debug',
          messageType,
        });
        assert.equal(
          result.shouldEmit,
          false,
          `${messageType} messages at debug level should be filtered when debug mode is off`,
        );
      }
    });
  });

  describe('debugMode flag', () => {
    it('returns debugMode false when debug mode is off', () => {
      const result = getEmitFilter({
        level: 'info',
        messageType: MESSAGE_TYPES.DEFAULT,
      });
      assert.equal(
        result.debugMode,
        false,
        'debugMode should be false when debug mode is off',
      );
    });
  });
});
