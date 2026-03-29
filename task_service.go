package main

type TaskService struct {
	store *DataStore
}

func NewTaskService(store *DataStore) *TaskService {
	return &TaskService{store: store}
}

func (s *TaskService) ServiceName() string {
	return "TaskService"
}

func (s *TaskService) ListTasks() []BackgroundTask {
	return s.store.ListTasks()
}
