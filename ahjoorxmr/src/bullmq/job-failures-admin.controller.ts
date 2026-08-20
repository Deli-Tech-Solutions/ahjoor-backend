import {
  Controller,
  Get,
  Post,
  Query,
  HttpCode,
  HttpStatus,
  Version,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JobFailureService } from './job-failure.service';
import type { JobFailureFilter } from './job-failure.service';

@ApiTags('Admin – Job Failures')
@ApiBearerAuth()
@Controller('admin/jobs/failures')
@Version('1')
export class JobFailuresAdminController {
  constructor(private readonly jobFailureService: JobFailureService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get paginated job failures (admin only)' })
  @ApiQuery({ name: 'queueName', required: false })
  @ApiQuery({ name: 'jobName', required: false })
  @ApiQuery({ name: 'from', required: false, description: 'ISO date string' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO date string' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'isPoison', required: false, type: Boolean, description: 'Filter by poison-message status' })
  @ApiResponse({ status: 200, description: 'Paginated job failures' })
  async getFailures(@Query() query: Record<string, any>) {
    // Convert isPoison string "true"/"false" to boolean
    const filter: JobFailureFilter = {
      queueName: query.queueName,
      jobName: query.jobName,
      from: query.from,
      to: query.to,
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      isPoison: query.isPoison !== undefined && query.isPoison !== ''
        ? query.isPoison === 'true' || query.isPoison === true
        : undefined,
    };
    const { data, total } = await this.jobFailureService.findAll(filter);
    return {
      data,
      total,
      page: Number(query.page ?? 1),
      limit: Number(query.limit ?? 20),
    };
  }

  @Post('retry-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry all failed jobs across all queues (admin only)' })
  @ApiResponse({ status: 200, description: 'Number of jobs retried' })
  async retryAll() {
    return this.jobFailureService.retryAll();
  }
}