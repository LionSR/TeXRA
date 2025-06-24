import * as assert from 'assert';
import { formatError } from '../errorHandlingUtils';

/**
 * Comprehensive test suite for error handling utilities.
 * 
 * This test suite focuses on the pure function `formatError` which can be tested
 * without mocking external dependencies. The other functions (logErrorMessage,
 * showLoggedErrorMessage, showLoggedMessage) depend on external modules and VS Code APIs
 * that would require complex mocking in the VS Code test environment.
 * 
 * The formatError function is the core building block that all other functions use,
 * so thorough testing of this function ensures the reliability of the entire module.
 */
suite('Error Handling Utils Test Suite', () => {

  suite('formatError - Core error formatting functionality', () => {
    test('should format Error object correctly', () => {
      const error = new Error('Test error message');
      const result = formatError('Operation failed', error);
      assert.strictEqual(result, 'Operation failed: Test error message');
    });

    test('should format string error correctly', () => {
      const error = 'String error message';
      const result = formatError('Operation failed', error);
      assert.strictEqual(result, 'Operation failed: String error message');
    });

    test('should format number error correctly', () => {
      const error = 404;
      const result = formatError('HTTP error', error);
      assert.strictEqual(result, 'HTTP error: 404');
    });

    test('should format null error correctly', () => {
      const error = null;
      const result = formatError('Null error', error);
      assert.strictEqual(result, 'Null error: null');
    });

    test('should format undefined error correctly', () => {
      const error = undefined;
      const result = formatError('Undefined error', error);
      assert.strictEqual(result, 'Undefined error: undefined');
    });

    test('should format boolean error correctly', () => {
      const error = false;
      const result = formatError('Boolean error', error);
      assert.strictEqual(result, 'Boolean error: false');
    });

    test('should format object error correctly', () => {
      const error = { code: 500, message: 'Internal error' };
      const result = formatError('Object error', error);
      assert.strictEqual(result, 'Object error: [object Object]');
    });

    test('should format array error correctly', () => {
      const error = ['error1', 'error2'];
      const result = formatError('Array error', error);
      assert.strictEqual(result, 'Array error: error1,error2');
    });

    test('should handle empty prefix', () => {
      const error = new Error('Test error');
      const result = formatError('', error);
      assert.strictEqual(result, ': Test error');
    });

    test('should handle empty error message', () => {
      const error = new Error('');
      const result = formatError('Empty error', error);
      assert.strictEqual(result, 'Empty error: ');
    });

    test('should handle whitespace-only prefix', () => {
      const error = new Error('Test error');
      const result = formatError('   ', error);
      assert.strictEqual(result, '   : Test error');
    });

    test('should handle special characters in prefix', () => {
      const prefix = 'Error with symbols: @#$%^&*()[]{}|\\:";\'<>?,./';
      const error = new Error('Special char test');
      const result = formatError(prefix, error);
      assert.strictEqual(result, `${prefix}: Special char test`);
    });

    test('should handle unicode characters', () => {
      const prefix = 'Unicode test 你好 🚀';
      const error = new Error('Unicode error message 测试 ⭐');
      const result = formatError(prefix, error);
      assert.strictEqual(result, 'Unicode test 你好 🚀: Unicode error message 测试 ⭐');
    });

    test('should handle very long error messages', () => {
      const longMessage = 'A'.repeat(1000);
      const error = new Error(longMessage);
      const result = formatError('Long error test', error);
      assert.strictEqual(result, `Long error test: ${longMessage}`);
    });

    test('should handle Error with custom properties', () => {
      const customError = new Error('Custom error message');
      (customError as any).code = 'CUSTOM_CODE';
      (customError as any).statusCode = 500;
      const result = formatError('Custom Error', customError);
      // Should still use the .message property for Error objects
      assert.strictEqual(result, 'Custom Error: Custom error message');
    });

    test('should handle TypeError correctly', () => {
      const error = new TypeError('Type error message');
      const result = formatError('Type error', error);
      assert.strictEqual(result, 'Type error: Type error message');
    });

    test('should handle ReferenceError correctly', () => {
      const error = new ReferenceError('Reference error message');
      const result = formatError('Reference error', error);
      assert.strictEqual(result, 'Reference error: Reference error message');
    });

    test('should handle SyntaxError correctly', () => {
      const error = new SyntaxError('Syntax error message');
      const result = formatError('Syntax error', error);
      assert.strictEqual(result, 'Syntax error: Syntax error message');
    });

    test('should handle circular reference objects gracefully', () => {
      const circularObj: any = { name: 'circular' };
      circularObj.self = circularObj;
      const result = formatError('Circular object test', circularObj);
      assert.strictEqual(result, 'Circular object test: [object Object]');
    });

    test('should handle Date objects', () => {
      const dateError = new Date('2023-01-01');
      const result = formatError('Date error', dateError);
      assert.strictEqual(result, 'Date error: Sun Jan 01 2023 00:00:00 GMT+0000 (Coordinated Universal Time)');
    });

    test('should handle RegExp objects', () => {
      const regexError = /test.*pattern/gi;
      const result = formatError('Regex error', regexError);
      assert.strictEqual(result, 'Regex error: /test.*pattern/gi');
    });

    test('should handle Function objects', () => {
      const fnError = function testFunction() { return 'test'; };
      const result = formatError('Function error', fnError);
      assert.ok(result.startsWith('Function error: function testFunction()'));
    });

    test('should handle Symbol primitives', () => {
      const symbolError = Symbol('test symbol');
      const result = formatError('Symbol error', symbolError);
      assert.strictEqual(result, 'Symbol error: Symbol(test symbol)');
    });

    test('should handle BigInt primitives', () => {
      const bigintError = BigInt(12345);
      const result = formatError('BigInt error', bigintError);
      assert.strictEqual(result, 'BigInt error: 12345');
    });

    test('should preserve error message with newlines', () => {
      const multilineError = new Error('Line 1\nLine 2\nLine 3');
      const result = formatError('Multiline error', multilineError);
      assert.strictEqual(result, 'Multiline error: Line 1\nLine 2\nLine 3');
    });

    test('should handle error message with tabs', () => {
      const tabError = new Error('Error\twith\ttabs');
      const result = formatError('Tab error', tabError);
      assert.strictEqual(result, 'Tab error: Error\twith\ttabs');
    });

    // Performance and consistency tests
    test('should be consistent with multiple calls', () => {
      const error = new Error('Consistency test');
      const result1 = formatError('Test prefix', error);
      const result2 = formatError('Test prefix', error);
      assert.strictEqual(result1, result2);
    });

    test('should handle rapid successive calls', () => {
      const error = new Error('Performance test');
      const results = [];
      
      for (let i = 0; i < 100; i++) {
        results.push(formatError(`Test ${i}`, error));
      }
      
      // All results should be properly formatted
      results.forEach((result, index) => {
        assert.strictEqual(result, `Test ${index}: Performance test`);
      });
    });
  });

  suite('Error formatting edge cases and integration scenarios', () => {
    test('should handle typical VS Code extension error patterns', () => {
      // File system errors
      const fsError = new Error('ENOENT: no such file or directory, open \'/path/to/file.txt\'');
      const fsResult = formatError('Failed to read file', fsError);
      assert.strictEqual(fsResult, 'Failed to read file: ENOENT: no such file or directory, open \'/path/to/file.txt\'');

      // Network errors
      const networkError = new Error('ENOTFOUND: getaddrinfo ENOTFOUND api.example.com');
      const networkResult = formatError('API request failed', networkError);
      assert.strictEqual(networkResult, 'API request failed: ENOTFOUND: getaddrinfo ENOTFOUND api.example.com');
    });

    test('should handle common API error response formats', () => {
      // HTTP error with status
      const httpError = { status: 404, message: 'Not Found', url: '/api/users/123' };
      const httpResult = formatError('HTTP request failed', httpError);
      assert.strictEqual(httpResult, 'HTTP request failed: [object Object]');

      // Simple string API error
      const apiStringError = 'Unauthorized: Invalid API key';
      const apiResult = formatError('Authentication failed', apiStringError);
      assert.strictEqual(apiResult, 'Authentication failed: Unauthorized: Invalid API key');
    });

    test('should handle validation error scenarios', () => {
      const validationErrors = [
        'Required field missing: inputFile',
        'Invalid format: expected .tex file',
        'Parameter out of range: maxIterations must be between 1 and 20'
      ];

      validationErrors.forEach((error, index) => {
        const result = formatError('Validation error', error);
        assert.strictEqual(result, `Validation error: ${error}`);
      });
    });

    test('should work with common error handling patterns', () => {
      // Try-catch error handling
      try {
        throw new Error('Something went wrong');
      } catch (err) {
        const result = formatError('Operation failed', err);
        assert.strictEqual(result, 'Operation failed: Something went wrong');
      }

      // Promise rejection handling
      const rejectionError = 'Promise was rejected';
      const rejectionResult = formatError('Async operation failed', rejectionError);
      assert.strictEqual(rejectionResult, 'Async operation failed: Promise was rejected');
    });

    test('should integrate well with common logging scenarios', () => {
      // Multiple error levels
      const errors = [
        { level: 'error', message: new Error('Critical failure') },
        { level: 'warning', message: 'Warning: deprecated function used' },
        { level: 'info', message: 'Process completed with warnings' }
      ];

      errors.forEach(({ level, message }) => {
        const result = formatError(`[${level.toUpperCase()}]`, message);
        if (message instanceof Error) {
          assert.strictEqual(result, `[${level.toUpperCase()}]: ${message.message}`);
        } else {
          assert.strictEqual(result, `[${level.toUpperCase()}]: ${message}`);
        }
      });
    });
  });
});