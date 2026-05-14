export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Indian Courier Tracking API',
    version: '1.0.0',
    description:
      'Unified tracking API for 12 Indian courier services. Provide just a tracking number — the API auto-detects the courier and returns normalised status, timeline, events, and location.',
  },
  servers: [{ url: 'http://localhost:3000', description: 'Local dev server' }],
  tags: [
    { name: 'tracking', description: 'Track a shipment' },
    { name: 'meta', description: 'API metadata' },
  ],
  paths: {
    '/track/{awb}': {
      get: {
        tags: ['tracking'],
        summary: 'Track by AWB (GET)',
        description:
          'Auto-detects the courier from the AWB pattern and returns full tracking data.',
        operationId: 'trackGet',
        parameters: [
          {
            name: 'awb',
            in: 'path',
            required: true,
            schema: { type: 'string', example: 'FMPC1234567890' },
            description: 'Tracking / AWB number',
          },
          {
            name: 'courier',
            in: 'query',
            required: false,
            schema: {
              type: 'string',
              enum: [
                'bluedart', 'delhivery', 'ekart', 'fedex', 'shiprocket',
                'dtdc', 'xpressbees', 'shadowfax', 'goswift', 'indiapost',
                'ecomexpress', 'amazon',
              ],
            },
            description: 'Override auto-detection by specifying courier slug',
          },
        ],
        responses: {
          200: { $ref: '#/components/responses/TrackingSuccess' },
          300: { $ref: '#/components/responses/Ambiguous' },
          400: { $ref: '#/components/responses/InvalidInput' },
          404: { $ref: '#/components/responses/NotFound' },
          502: { $ref: '#/components/responses/UpstreamError' },
          503: { $ref: '#/components/responses/CourierUnavailable' },
        },
      },
    },
    '/track': {
      post: {
        tags: ['tracking'],
        summary: 'Track by AWB (POST)',
        description:
          'Same as GET but accepts JSON body. Useful for AWBs with special characters or when passing courier hint.',
        operationId: 'trackPost',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['tracking_number'],
                properties: {
                  tracking_number: {
                    type: 'string',
                    example: 'FMPC1234567890',
                    description: 'Tracking / AWB number',
                  },
                  courier: {
                    type: 'string',
                    example: 'ekart',
                    description: 'Optional courier slug to skip auto-detection',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { $ref: '#/components/responses/TrackingSuccess' },
          300: { $ref: '#/components/responses/Ambiguous' },
          400: { $ref: '#/components/responses/InvalidInput' },
          404: { $ref: '#/components/responses/NotFound' },
          502: { $ref: '#/components/responses/UpstreamError' },
          503: { $ref: '#/components/responses/CourierUnavailable' },
        },
      },
    },
    '/couriers': {
      get: {
        tags: ['meta'],
        summary: 'List supported couriers',
        operationId: 'listCouriers',
        responses: {
          200: {
            description: 'Array of courier objects',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      slug: { type: 'string', example: 'delhivery' },
                      name: { type: 'string', example: 'Delhivery' },
                      patterns: {
                        type: 'array',
                        items: { type: 'string' },
                        example: ['/^\\d{16,22}$/'],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/health': {
      get: {
        tags: ['meta'],
        summary: 'Health check',
        operationId: 'health',
        responses: {
          200: {
            description: 'API is running',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                    couriers: {
                      type: 'array',
                      items: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      StatusCode: {
        type: 'string',
        enum: [
          'PENDING', 'PICKUP_PENDING', 'IN_TRANSIT', 'OUT_FOR_DELIVERY',
          'DELIVERED', 'EXCEPTION', 'RTO', 'RTO_DELIVERED',
          'TRACKING_LINK_REQUIRED', 'UNKNOWN',
        ],
      },
      TrackingEvent: {
        type: 'object',
        properties: {
          timestamp: { type: 'string', nullable: true, example: '2024-06-01T10:30:00' },
          status: { $ref: '#/components/schemas/StatusCode' },
          description: { type: 'string', example: 'Package in transit to hub' },
          location: { type: 'string', nullable: true, example: 'Mumbai Hub' },
          city: { type: 'string', nullable: true, example: 'Mumbai' },
          state: { type: 'string', nullable: true, example: 'Maharashtra' },
        },
      },
      TrackingResult: {
        type: 'object',
        properties: {
          tracking_number: { type: 'string', example: 'FMPC1234567890' },
          courier: {
            type: 'object',
            properties: {
              slug: { type: 'string', example: 'ekart' },
              name: { type: 'string', example: 'Ekart' },
              detected: { type: 'string', nullable: true },
              confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            },
          },
          status: {
            type: 'object',
            properties: {
              code: { $ref: '#/components/schemas/StatusCode' },
              label: { type: 'string', example: 'In Transit' },
              description: { type: 'string', example: 'In transit to destination' },
              is_final: { type: 'boolean' },
            },
          },
          timeline: {
            type: 'object',
            properties: {
              pickup_date: { type: 'string', nullable: true },
              estimated_delivery: { type: 'string', nullable: true },
              actual_delivery: { type: 'string', nullable: true },
              days_in_transit: { type: 'integer', nullable: true },
            },
          },
          location: {
            type: 'object',
            properties: {
              current_city: { type: 'string', nullable: true },
              current_state: { type: 'string', nullable: true },
              current_pincode: { type: 'string', nullable: true },
              origin_city: { type: 'string', nullable: true },
              origin_state: { type: 'string', nullable: true },
              destination_city: { type: 'string', nullable: true },
              destination_state: { type: 'string', nullable: true },
              destination_pincode: { type: 'string', nullable: true },
            },
          },
          events: {
            type: 'array',
            items: { $ref: '#/components/schemas/TrackingEvent' },
          },
          delivery_attempts: {
            type: 'object',
            nullable: true,
            properties: {
              count: { type: 'integer', nullable: true },
              last_attempt_date: { type: 'string', nullable: true },
              failure_reason: { type: 'string', nullable: true },
            },
          },
          shipment_details: {
            type: 'object',
            properties: {
              weight_kg: { type: 'number', nullable: true },
              dimensions: { type: 'string', nullable: true },
              product_description: { type: 'string', nullable: true },
              pieces: { type: 'integer', nullable: true },
            },
          },
          flags: {
            type: 'object',
            properties: {
              is_express: { type: 'boolean', nullable: true },
              is_cod: { type: 'boolean', nullable: true },
              cod_amount: { type: 'number', nullable: true },
              is_rto: { type: 'boolean' },
              is_ndr: { type: 'boolean' },
            },
          },
          raw: {
            type: 'object',
            description: 'Raw response from the upstream courier API (for debugging)',
          },
        },
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          error: { type: 'string', example: 'NOT_FOUND' },
          message: { type: 'string', example: 'Shipment not found' },
          courier: { type: 'string', nullable: true },
        },
      },
    },
    responses: {
      TrackingSuccess: {
        description: 'Tracking data retrieved successfully',
        headers: {
          'X-Cache': {
            schema: { type: 'string', enum: ['HIT', 'MISS'] },
            description: 'Whether the result was served from cache',
          },
        },
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/TrackingResult' } },
        },
      },
      NotFound: {
        description: 'Shipment not found with any courier',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
        },
      },
      Ambiguous: {
        description: 'AWB matches multiple couriers — provide a courier hint',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                error: { type: 'string', example: 'AMBIGUOUS' },
                message: { type: 'string' },
                candidates: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      InvalidInput: {
        description: 'Missing or invalid input',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
        },
      },
      UpstreamError: {
        description: 'Courier API returned an unexpected error',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
        },
      },
      CourierUnavailable: {
        description: 'Courier adapter is not configured (missing credentials)',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
        },
      },
    },
  },
};
